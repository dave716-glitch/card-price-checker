const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

async function scrapeEbaySoldListings(cardInfo) {
  const { player, year, brand, series, cardNumber } = cardInfo;
  
  let browser = null;
  
  try {
    // Build search query
    const searchTerms = [year, brand, series, player, cardNumber]
      .filter(t => t && t !== 'Not visible')
      .join(' ');
    
    console.log('🚀 Starting eBay scraper...');
    console.log('Card info:', cardInfo);
    console.log('🔍 Search query:', searchTerms);
    
    // Launch browser with cloud-friendly Chromium
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });
    
    const page = await browser.newPage();
    
    // Navigate to eBay sold listings
    const ebayUrl = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(searchTerms)}&_sacat=0&LH_Sold=1&LH_Complete=1&rt=nc&LH_ItemCondition=3000`;
    
    console.log('🌐 Navigating to eBay...');
    await page.goto(ebayUrl, { 
      waitUntil: 'networkidle0',
      timeout: 30000 
    });
    
    // Wait for results
    await page.waitForSelector('.s-item', { timeout: 10000 });
    
    console.log('📊 Extracting sold listings...');
    
    // Extract sold listings
    const soldListings = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.s-item'));
      const listings = [];
      
      items.forEach(item => {
        try {
          const title = item.querySelector('.s-item__title')?.innerText?.toLowerCase() || '';
          
          // Skip ads and irrelevant items
          if (title.includes('shop on ebay') || title.includes('related sponsored items')) {
            return;
          }
          
          // Filter out graded cards
          if (title.includes('psa') || title.includes('bgs') || title.includes('sgc') || 
              title.includes('graded') || title.includes('gem mint') || 
              title.includes('psa 10') || title.includes('bgs 9.5')) {
            return;
          }
          
          const priceText = item.querySelector('.s-item__price')?.innerText || '';
          const price = parseFloat(priceText.replace(/[^0-9.]/g, ''));
          
          if (isNaN(price) || price <= 0 || price > 10000) {
            return;
          }
          
          listings.push({
            price: price,
            title: title
          });
        } catch (err) {
          // Skip items that fail to parse
        }
      });
      
      return listings;
    });
    
    console.log(`📈 Found ${soldListings.length} raw sold listings`);
    
    // Close browser
    await browser.close();
    browser = null;
    
    // Filter outliers
    if (soldListings.length > 0) {
      const prices = soldListings.map(l => l.price).sort((a, b) => a - b);
      
      // Calculate quartiles for outlier detection
      const q1Index = Math.floor(prices.length * 0.25);
      const q3Index = Math.floor(prices.length * 0.75);
      const q1 = prices[q1Index];
      const q3 = prices[q3Index];
      const iqr = q3 - q1;
      
      // Remove outliers (values outside 1.5 * IQR)
      const lowerBound = q1 - (1.5 * iqr);
      const upperBound = q3 + (1.5 * iqr);
      
      const filteredPrices = prices.filter(p => p >= lowerBound && p <= upperBound);
      
      console.log(`✅ After filtering outliers: ${filteredPrices.length} listings`);
      
      if (filteredPrices.length === 0) {
        return {
          success: false,
          message: 'No valid prices found after filtering'
        };
      }
      
      // Calculate average
      const sum = filteredPrices.reduce((a, b) => a + b, 0);
      const average = sum / filteredPrices.length;
      
      console.log(`💰 Average price: $${average.toFixed(2)}`);
      console.log(`📈 Range: $${Math.min(...filteredPrices).toFixed(2)} - $${Math.max(...filteredPrices).toFixed(2)}`);
      
      return {
        success: true,
        averagePrice: parseFloat(average.toFixed(2)),
        soldCount: filteredPrices.length,
        priceRange: {
          low: Math.min(...filteredPrices),
          high: Math.max(...filteredPrices)
        },
        allPrices: filteredPrices
      };
    } else {
      return {
        success: false,
        message: 'No sold listings found'
      };
    }
    
  } catch (error) {
    console.error('❌ Error scraping eBay:', error);
    
    // Make sure browser is closed
    if (browser) {
      await browser.close();
    }
    
    return {
      success: false,
      error: error.message
    };
  }
}

module.exports = {
  scrapeEbaySoldListings
};
