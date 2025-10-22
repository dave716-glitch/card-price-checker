require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const cors = require('cors');
const axios = require('axios');
const { scrapeEbaySoldListings } = require('./ebay-scraper');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// SportsCardsPro token (fallback)
const SPORTSCARDSPRO_TOKEN = process.env.SPORTSCARDSPRO_TOKEN;

// Exchange rate endpoint
app.get('/api/exchange-rate', async (req, res) => {
  try {
    const response = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
    const data = await response.json();
    res.json({ 
      success: true, 
      rate: data.rates.CAD,
      source: 'live'
    });
  } catch (error) {
    console.error('Exchange rate fetch failed:', error);
    res.json({ 
      success: true, 
      rate: 1.4,
      source: 'fallback'
    });
  }
});

// Identify card using Claude Vision
app.post('/api/identify-card', async (req, res) => {
  try {
    const { image } = req.body;

    console.log('🔍 Analyzing card image...');

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/jpeg',
                data: image,
              },
            },
            {
              type: 'text',
              text: `Analyze this sports card and extract the following information:
- Player name (first and last name)
- Year (the season, like "2023-24" or "2024-25")
- Brand (Upper Deck, Topps, Panini, etc.)
- Series (Series 1, Series 2, Chrome, Prizm, etc. - if visible)
- Sport (hockey, basketball, baseball, football, soccer)
- Card number (if visible)
- Parallel/variant (if any special designation like Prizm, Refractor, etc.)

Return ONLY a JSON object with this structure:
{
  "player": "Player Name",
  "year": "2024-25",
  "brand": "Brand Name",
  "series": "Series Name",
  "sport": "sport name",
  "cardNumber": "123" or "Not visible",
  "parallel": "Base" or "variant name"
}

If the card number is not visible, use "Not visible". If there's no parallel/variant, use "Base". If it's a checklist card with multiple players, include both names separated by " & ". Only return the JSON, nothing else.`
            }
          ],
        },
      ],
    });

    const cardInfo = JSON.parse(message.content[0].text);
    console.log('✅ Card identified:', cardInfo);
    
    res.json({ success: true, cardInfo });
  } catch (error) {
    console.error('❌ Error identifying card:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get price using eBay scraper (with SportsCardsPro fallback)
app.post('/api/get-price', async (req, res) => {
  try {
    const { cardInfo } = req.body;
    
    console.log('\n========== GETTING PRICE ==========');
    console.log('Card:', cardInfo);
    
    // Try eBay scraper first
    console.log('💻 Trying eBay scraper...');
    const scraperResult = await scrapeEbaySoldListings(cardInfo);
    
    if (scraperResult.success) {
      console.log('✅ eBay scraper succeeded!');
      return res.json({
        success: true,
        pricing: {
          found: true,
          price: scraperResult.averagePrice,
          salesVolume: scraperResult.soldCount,
          priceRange: scraperResult.priceRange,
          source: 'eBay Scraper (Live Data)',
          cardName: `${cardInfo.player} ${cardInfo.year}`,
          setName: `${cardInfo.brand} ${cardInfo.series}`
        }
      });
    }
    
    // Fallback to SportsCardsPro
    console.log('⚠️ eBay scraper failed, falling back to SportsCardsPro...');
    console.log('Scraper error:', scraperResult.message || scraperResult.error);
    
    const sportsCardsProResult = await searchSportsCardsPro(cardInfo);
    
    if (sportsCardsProResult.found) {
      console.log('✅ SportsCardsPro fallback succeeded!');
      return res.json({
        success: true,
        pricing: {
          ...sportsCardsProResult,
          source: 'SportsCardsPro (Fallback)'
        }
      });
    }
    
    // Both failed
    console.log('❌ Both eBay scraper and SportsCardsPro failed');
    return res.json({
      success: false,
      pricing: {
        found: false,
        message: 'Could not find pricing for this card from any source'
      }
    });
    
  } catch (error) {
    console.error('❌ Error getting price:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      pricing: {
        found: false,
        message: 'Error retrieving price'
      }
    });
  }
});

// SportsCardsPro search function (fallback)
async function searchSportsCardsPro(cardInfo) {
  try {
    // Build search query
    const searchTerms = [
      cardInfo.player,
      cardInfo.year,
      cardInfo.brand,
      cardInfo.series,
      cardInfo.cardNumber !== 'Not visible' ? cardInfo.cardNumber : '',
      cardInfo.parallel !== 'Base' ? cardInfo.parallel : ''
    ].filter(term => term).join(' ');
    
    console.log('SportsCardsPro search:', searchTerms);
    
    const searchUrl = `https://www.sportscardspro.com/api/search?t=${SPORTSCARDSPRO_TOKEN}&q=${encodeURIComponent(searchTerms)}&category=Non-Sport`;
    const searchResponse = await axios.get(searchUrl);
    
    if (searchResponse.data.status !== 'success' || !searchResponse.data.results || searchResponse.data.results.length === 0) {
      return {
        found: false,
        message: 'Card not found in SportsCardsPro database'
      };
    }
    
    // Filter and sort results
    let products = searchResponse.data.results;
    products = filterVariants(products, cardInfo);
    products = smartSort(products, cardInfo);
    
    if (products.length === 0) {
      return {
        found: false,
        message: 'No matching cards found after filtering'
      };
    }
    
    const bestMatch = products[0];
    
    // Get detailed pricing
    const detailsUrl = `https://www.sportscardspro.com/api/product?t=${SPORTSCARDSPRO_TOKEN}&id=${bestMatch.id}`;
    const detailsResponse = await axios.get(detailsUrl);
    const details = detailsResponse.data;
    
    if (details.status !== 'success') {
      return {
        found: false,
        message: 'Could not retrieve pricing details'
      };
    }
    
    const rawPrice = details['loose-price'] ? parseFloat(details['loose-price']) / 100 : null;
    const salesVolume = details['sales-volume'] || 'Unknown';
    
    return {
      found: true,
      cardName: bestMatch['product-name'],
      setName: bestMatch['console-name'],
      price: rawPrice,
      salesVolume: salesVolume,
      cardId: bestMatch.id
    };
    
  } catch (error) {
    console.error('SportsCardsPro search error:', error.message);
    return {
      found: false,
      message: 'Error searching SportsCardsPro'
    };
  }
}

function filterVariants(products, cardInfo) {
  const queryLower = (cardInfo.parallel || '').toLowerCase();
  const conditionalVariants = [
    "canvas", "exclusive", "acetate", "deluxe", 
    "outburst", "clear cut", "high gloss", "rainbow",
    "spectrum", "silver", "gold", "platinum",
    "parallel", "refractor", "prizm", "foil",
    "chrome", "sparkle", "shimmer", "now"
  ];
  
  const wantsSpecificVariant = queryLower && queryLower !== 'base' && queryLower !== '';
  const wantsConditionalVariant = conditionalVariants.some(term => queryLower.includes(term));
  
  return products.filter(product => {
    const productName = product['product-name'].toLowerCase();
    const consoleName = product['console-name'].toLowerCase();
    const fullText = productName + ' ' + consoleName;
    
    if (fullText.includes('oversized')) return false;
    
    if (wantsSpecificVariant) {
      if (!fullText.includes(queryLower)) return false;
    }
    
    if (!wantsConditionalVariant) {
      for (const term of conditionalVariants) {
        if (fullText.includes(term)) return false;
      }
    }
    
    return true;
  });
}

function smartSort(products, cardInfo) {
  return products.sort((a, b) => {
    const aName = a['console-name'].toLowerCase();
    const bName = b['console-name'].toLowerCase();
    const sport = cardInfo.sport.toLowerCase();
    
    if (sport === 'basketball' || sport === 'baseball') {
      const aIsBase = !['now', 'chrome', 'select', 'prizm', 'optic', 'mosaic', 'contenders']
        .some(keyword => aName.includes(keyword));
      const bIsBase = !['now', 'chrome', 'select', 'prizm', 'optic', 'mosaic', 'contenders']
        .some(keyword => bName.includes(keyword));
      
      if (aIsBase && !bIsBase) return -1;
      if (!aIsBase && bIsBase) return 1;
    }
    
    if (sport === 'hockey') {
      const aIsFlagship = aName.match(/^hockey cards \d{4}(-\d{2})? upper deck$/);
      const bIsFlagship = bName.match(/^hockey cards \d{4}(-\d{2})? upper deck$/);
      
      if (aIsFlagship && !bIsFlagship) return -1;
      if (!aIsFlagship && bIsFlagship) return 1;
    }
    
    return aName.split(' ').length - bName.split(' ').length;
  });
}

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log('💻 eBay scraper enabled with SportsCardsPro fallback');
});
