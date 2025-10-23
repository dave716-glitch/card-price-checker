require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const cors = require('cors');
const multer = require('multer');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SPORTSCARDSPRO_TOKEN = process.env.SPORTSCARDSPRO_API_TOKEN;

// Identify card from image using Claude
app.post('/api/identify-card', upload.single('image'), async (req, res) => {
  try {
    const imageBuffer = req.file.buffer;
    const base64Image = imageBuffer.toString('base64');
    
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
                media_type: req.file.mimetype,
                data: base64Image,
              },
            },
            {
              type: 'text',
              text: `You are analyzing a sports card image. Read ALL text on the card VERY CAREFULLY.

Please identify:
- Player name (read carefully, check spelling)
- Year or year range (e.g., 2024-25)
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

    // eBay scraper is temporarily disabled
    console.log('⚠️ eBay scraper disabled, using SportsCardsPro...');
    
    const sportsCardsProResult = await searchSportsCardsPro(cardInfo);
    
    console.log('SportsCardsPro result:', JSON.stringify(sportsCardsProResult, null, 2));
    
    if (sportsCardsProResult.found) {
      console.log('✅ SportsCardsPro succeeded!');
      return res.json({
        success: true,
        pricing: {
          ...sportsCardsProResult,
          source: 'SportsCardsPro'
        }
      });
    }
    
    // Failed
    console.log('❌ SportsCardsPro failed');
    return res.json({
      success: false,
      pricing: {
        found: false,
        message: 'Could not find pricing for this card'
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

    const response = await axios.get('https://www.sportscardspro.com/api/products', {
      params: {
        q: searchTerms,
        t: SPORTSCARDSPRO_TOKEN
      },
      timeout: 10000
    });

    if (!response.data || response.data.status !== 'success' || !response.data.products || response.data.products.length === 0) {
      return { found: false, message: 'No results found' };
    }

    // Filter and sort results
    const filteredCards = filterAndSortCards(response.data.products, cardInfo);
    
    if (filteredCards.length === 0) {
      return { found: false, message: 'No matching cards after filtering' };
    }

    const topCard = filteredCards[0];
    
    // Raw card price is in 'loose-price' field and is in PENNIES
    const rawPricePennies = topCard['loose-price'];

    if (!rawPricePennies || rawPricePennies === 0) {
      return { found: false, message: 'Card found but no price available' };
    }

    // Convert pennies to dollars
    const rawPrice = rawPricePennies / 100;

    return {
      found: true,
      price: rawPrice,
      salesVolume: topCard['sales-volume'] || 0,
      cardName: topCard['product-name'],
      setName: topCard['console-name']
    };

  } catch (error) {
    console.error('SportsCardsPro API error:', error.message);
    return { found: false, error: error.message };
  }
}

// Filter and sort cards based on card info
function filterAndSortCards(cards, cardInfo) {
  const { sport, parallel, cardNumber } = cardInfo;
  
  // Variants to exclude unless specifically requested
  const excludeVariants = [
    'canvas', 'exclusive', 'acetate', 'deluxe', 'outburst',
    'clear cut', 'high gloss', 'rainbow', 'spectrum',
    'silver', 'gold', 'platinum', 'refractor', 'prizm',
    'foil', 'chrome', 'sparkle', 'shimmer', 'jumbo'
  ];
  
  // Filter cards
  const filtered = cards.filter(card => {
    // Sport-specific filtering
    if (sport === 'hockey' && !card['console-name']?.toLowerCase().includes('hockey')) {
      return false;
    }
    if (sport === 'basketball' && !card['console-name']?.toLowerCase().includes('basketball')) {
      return false;
    }
    
    const productLower = card['product-name']?.toLowerCase() || '';
    const setLower = card['console-name']?.toLowerCase() || '';
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
    return smartSort(filtered, sport);
  }

  return filtered;
}

// Smart sort to prioritize base sets
function smartSort(cards, sport) {
  const deprioritize = ['now', 'chrome', 'select', 'prizm', 'optic', 'mosaic', 'update', 'opening day'];
  
  return cards.sort((a, b) => {
    const aText = (a['product-name'] + ' ' + a['console-name']).toLowerCase();
    const bText = (b['product-name'] + ' ' + b['console-name']).toLowerCase();
    
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log('💻 eBay scraper disabled, using SportsCardsPro only');
});
