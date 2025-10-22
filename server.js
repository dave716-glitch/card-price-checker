const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const cors = require('cors');
const { scrapeEbaySoldListings } = require('./ebay-scraper');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// SportsCardsPro API config
const SPORTSCARDSPRO_TOKEN = process.env.SPORTSCARDSPRO_TOKEN;

// Exchange rate endpoint
app.get('/api/exchange-rate', async (req, res) => {
  try {
    const response = await axios.get('https://api.exchangerate-api.com/v4/latest/USD');
    const rate = response.data.rates.CAD;
    res.json({ success: true, rate, source: 'live' });
  } catch (error) {
    console.error('Exchange rate API error:', error.message);
    res.json({ success: true, rate: 1.4, source: 'fallback' });
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

    // Strip markdown code blocks if present
    let cleanContent = message.content[0].text.trim();
    if (cleanContent.startsWith('```')) {
      cleanContent = cleanContent.replace(/^```json\n?/g, '').replace(/\n?```$/g, '');
    }
    const cardInfo = JSON.parse(cleanContent);

    console.log('✅ Card identified:', cardInfo);

    res.json({
      success: true,
      cardInfo
    });

  } catch (error) {
    console.error('❌ Error identifying card:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get price for identified card
app.post('/api/get-price', async (req, res) => {
  try {
    const { cardInfo } = req.body;

    console.log('========== GETTING PRICE ==========');
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
          source: 'eBay (Live Sold Listings)',
          priceRange: scraperResult.priceRange
        }
      });
    }

    // Fallback to SportsCardsPro
    console.log('⚠️ eBay scraper failed, falling back to SportsCardsPro...');
    console.log('Scraper error:', scraperResult.message || scraperResult.error);
    
    const sportsCardsProResult = await searchSportsCardsPro(cardInfo);
    
    // ADD DETAILED LOGGING
    console.log('SportsCardsPro result:', JSON.stringify(sportsCardsProResult, null, 2));
    
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
    
    // Both methods failed
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
      error: error.message
    });
  }
});

// Search SportsCardsPro API
async function searchSportsCardsPro(cardInfo) {
  try {
    const { player, year, brand, series, cardNumber, parallel, sport } = cardInfo;
    
    // Build search query
    const searchTerms = [player, year, brand, series].filter(t => t && t !== 'Not visible').join(' ');
    console.log('SportsCardsPro search:', searchTerms);

    const response = await axios.get('https://api.sportscardspro.com/v1/search', {
      params: {
        q: searchTerms,
        token: SPORTSCARDSPRO_TOKEN
      },
      timeout: 10000
    });

    if (!response.data || !response.data.results || response.data.results.length === 0) {
      return { found: false, message: 'No results found' };
    }

    // Filter and sort results
    const filteredCards = filterAndSortCards(response.data.results, cardInfo);
    
    if (filteredCards.length === 0) {
      return { found: false, message: 'No matching cards after filtering' };
    }

    const topCard = filteredCards[0];
    const rawPrice = topCard.raw_price;

    if (!rawPrice || rawPrice === 0) {
      return { found: false, message: 'Card found but no price available' };
    }

    return {
      found: true,
      price: rawPrice,
      salesVolume: topCard.sales_volume || 0,
      cardName: topCard.product_name,
      setName: topCard.set_name
    };

  } catch (error) {
    console.error('SportsCardsPro API error:', error.message);
    return { found: false, error: error.message };
  }
}

// Filter and sort cards
function filterAndSortCards(cards, targetCard) {
  const { sport, parallel, cardNumber } = targetCard;
  
  // Filter variants to exclude
  const excludeVariants = ['prizm', 'chrome', 'optic', 'select', 'mosaic', 'refractor', 'shimmer', 'holo', 'silver', 'gold', 'auto', 'autograph', 'patch', 'relic', 'jersey', 'rookie ticket', 'numbered', 'insert', 'parallel', 'now'];
  
  let filtered = cards.filter(card => {
    // Sport filter
    if (sport === 'hockey' && !card.set_name?.toLowerCase().includes('hockey')) {
      return false;
    }
    if (sport === 'basketball' && !card.set_name?.toLowerCase().includes('basketball')) {
      return false;
    }
    
    const productLower = card.product_name?.toLowerCase() || '';
    const setLower = card.set_name?.toLowerCase() || '';
    const combinedText = productLower + ' ' + setLower;
    
    // If user specified a parallel, REQUIRE exact match
    if (parallel && parallel.toLowerCase() !== 'base') {
      const parallelLower = parallel.toLowerCase();
      if (!combinedText.includes(parallelLower)) {
        return false;
      }
    }
    
    // If looking for base card, exclude special variants
    if (!parallel || parallel.toLowerCase() === 'base') {
      for (const variant of excludeVariants) {
        if (combinedText.includes(variant)) {
          return false;
        }
      }
    }
    
    // Card number match (if specified and not "Not visible")
    if (cardNumber && cardNumber !== 'Not visible') {
      if (!productLower.includes(`#${cardNumber.toLowerCase()}`)) {
        return false;
      }
    }
    
    return true;
  });

  // Smart sorting for base cards
  if (!parallel || parallel.toLowerCase() === 'base') {
    filtered = smartSort(filtered, sport);
  }

  return filtered;
}

// Smart sort to prioritize base sets
function smartSort(cards, sport) {
  const deprioritize = ['now', 'chrome', 'select', 'prizm', 'optic', 'mosaic', 'update', 'opening day'];
  
  return cards.sort((a, b) => {
    const aText = (a.product_name + ' ' + a.set_name).toLowerCase();
    const bText = (b.product_name + ' ' + b.set_name).toLowerCase();
    
    // For basketball/baseball base cards, prioritize simple "Brand" sets
    if (sport === 'basketball' || sport === 'baseball') {
      const aHasDeprioritized = deprioritize.some(term => aText.includes(term));
      const bHasDeprioritized = deprioritize.some(term => bText.includes(term));
      
      if (aHasDeprioritized && !bHasDeprioritized) return 1;
      if (!aHasDeprioritized && bHasDeprioritized) return -1;
    }
    
    // For hockey, prioritize Young Guns
    if (sport === 'hockey') {
      const aIsYoungGuns = aText.includes('young guns');
      const bIsYoungGuns = bText.includes('young guns');
      
      if (aIsYoungGuns && !bIsYoungGuns) return -1;
      if (!aIsYoungGuns && bIsYoungGuns) return 1;
    }
    
    return 0;
  });
}

// Start server
app.listen(port, () => {
  console.log(`🚀 Server running on http://localhost:${port}`);
  console.log('💻 eBay scraper enabled with SportsCardsPro fallback');
});
