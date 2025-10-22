const puppeteer = require('puppeteer');

/**
 * Scrapes eBay sold listings for a sports card and calculates average price
 * @param {Object} cardInfo - Card details from Claude Vision
 * @returns {Object} - Average price and sold listings data
 */
async function scrapeEbaySoldListings(cardInfo) {
  let browser = null;
  
  try {
    console.log('🚀 Starting eBay scraper...');
    console.log('Card info:', cardInfo);
    
    // Build search query
    const searchTerms = [
      cardInfo.year,
      cardInfo.brand,
      cardInfo.series,
      cardInfo.player,
      cardInfo.cardNumber !== 'Not visible' ? `#${cardInfo.cardNumber}` : '',
      cardInfo.parallel && cardInfo.parallel !== 'Base' ? cardInfo.parallel : ''
    ].filter(term => term).join(' ');
    
    console.log('🔍 Search query:', searchTerms);
    
    // Launch browser
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
    
    const page = await browser.newPage();
    
    // Set realistic user agent to avoid detection
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Build eBay URL for sold listings
    const searchQuery = encodeURIComponent(searchTerms);
    const ebayUrl = `https://www.ebay.com/sch/i.html?_from=R40&_nkw=${searchQuery}&_sacat=0&LH_Sold=1&LH_Complete=1&rt=nc&LH_ItemCondition=3000`;
    
    console.log('🌐 Navigating to eBay...');
    await page.goto(ebayUrl, { 
      waitUntil: 'networkidle2',
      timeout: 30000 
    });
    
    // Add small delay to appear more human
    await page.waitForTimeout(1000 + Math.random() * 2000);
    
    console.log('📊 Extracting sold listings...');
    
    // Extract sold listings data
    const soldListings = await page.evaluate(() => {
      const listings = [];
      
      // eBay's sold listings appear in these classes
      const items = document.querySelectorAll('.s-item');
      
      items.forEach(item => {
        try {
          // Get title
          const titleElement = item.querySelector('.s-item__title');
          const title = titleElement ? titleElement.textContent.trim() : '';
          
          // Skip if it's a header or ad
          if (title === 'Shop on eBay' || !title) return;
          
          // Get price
          const priceElement = item.querySelector('.s-item__price');
          if (!priceElement) return;
          
          const priceText = priceElement.textContent.trim();
          const priceMatch = priceText.match(/\$?([\d,]+\.?\d*)/);
          if (!priceMatch) return;
          
          const price = parseFloat(priceMatch[1].replace(/,/g, ''));
          
          // Filter out graded cards
          const titleLower = title.toLowerCase();
          const gradingTerms = ['psa', 'bgs', 'sgc', 'cgc', 'graded', 'gem', 'mint 10', 'bccg', 'hga', 'slab'];
          const isGraded = gradingTerms.some(term => titleLower.includes(term));
          
          if (isGraded) return;
          
          // Filter out unreasonably high prices (likely errors or lots)
          if (price > 10000) return;
          
          // Filter out unreasonably low prices (likely damaged or incomplete)
          if (price < 0.50) return;
          
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
    
    // Check if we found any listings
    if (soldListings.length === 0) {
      return {
        success: false,
        message: 'No sold listings found for this card'
      };
    }
    
    // Filter outliers using IQR method
    const prices = soldListings.map(l => l.price).sort((a, b) => a - b);
    
    // Calculate quartiles
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
    console.log(`📊 Range: $${Math.min(...filteredPrices).toFixed(2)} - $${Math.max(...filteredPrices).toFixed(2)}`);
    
    return {
      success: true,
      averagePrice: parseFloat(average.toFixed(2)),
      soldCount: filteredPrices.length,
      priceRange: {
        low: Math.min(...filteredPrices),
        high: Math.max(...filteredPrices)
      },
      allPrices: filteredPrices,
      source: 'eBay Scraper'
    };
    
  } catch (error) {
    console.error('❌ Error scraping eBay:', error);
    
    // Make sure browser is closed on error
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
