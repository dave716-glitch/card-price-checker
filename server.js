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

If the card number is not visible, use "Not visible". If there's no parallel/variant, use "Base". If it's a checklist card with multiple players, include both names separated by " & ".`,
            },
          ],
        },
      ],
    });

    let responseText = message.content[0].text;
    
    // Strip markdown code blocks if present
    responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    const cardInfo = JSON.parse(responseText);
    
    console.log('✅ Card identified:', cardInfo);

    res.json({
      success: true,
      cardInfo: cardInfo,
    });
  } catch (error) {
    console.error('❌ Error identifying card:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get price using SportsCardsPro API
app.post('/api/get-price', async (req, res) => {
  try {
    const { cardInfo } = req.body;

    console.log('========== GETTING PRICE ==========');
    console.log('Card:', cardInfo);

    // Search SportsCardsPro
    const pricing = await searchSportsCardsPro(cardInfo);

    if (pricing.found) {
      console.log('✅ SportsCardsPro succeeded!');
      res.json({
        success: true,
        pricing: pricing,
      });
    } else {
      console.log('❌ SportsCardsPro failed');
      res.json({
        success: false,
        pricing: pricing,
      });
    }
  } catch (error) {
    console.error('❌ Error getting price:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// SportsCardsPro search function
async function searchSportsCardsPro(cardInfo) {
  try {
    const { player, year, brand, series, sport, cardNumber, parallel } = cardInfo;

    // Build search query
    const searchTerms = [player, year, brand, series].filter(Boolean).join(' ');
    
    console.log('SportsCardsPro search:', searchTerms);

    const response = await axios.get('https://www.sportscardspro.com/api/products', {
      params: {
        q: searchTerms,
        t: SPORTSCARDSPRO_TOKEN,
      },
    });

    if (!response.data || !Array.isArray(response.data)) {
      return { found: false, message: 'Invalid API response' };
    }

    console.log(`Found ${response.data.length} results from SportsCardsPro`);

    // Filter results
    const filtered = filterCards(response.data, cardInfo);

    console.log(`After filtering: ${filtered.length} results`);

    if (filtered.length === 0) {
      return { found: false, message: 'No matching cards found after filtering' };
    }

    // Get the best match (first result after filtering)
    const bestMatch = filtered[0];

    console.log('===== MATCHED CARD =====');
    console.log('Product:', bestMatch.product_name);
    console.log('Set:', bestMatch.set_name);
    console.log('Raw price (pennies):', bestMatch['loose-price']);

    // Price is in pennies, convert to dollars
    const rawPrice = bestMatch['loose-price'] ? bestMatch['loose-price'] / 100 : null;

    if (!rawPrice) {
      return { found: false, message: 'Card found but no price data available' };
    }

    return {
      found: true,
      price: rawPrice,
      source: 'SportsCardsPro',
      salesVolume: 'N/A',
      cardDetails: {
        productName: bestMatch.product_name,
        setName: bestMatch.set_name,
      },
    };
  } catch (error) {
    console.error('SportsCardsPro error:', error.message);
    return { found: false, message: `SportsCardsPro API error: ${error.message}` };
  }
}

// Filter cards by sport, parallel, and card number
function filterCards(cards, cardInfo) {
  const { sport, parallel, cardNumber } = cardInfo;

  // Variants to exclude for base cards
  const excludeVariants = [
    'prizm', 'chrome', 'refractor', 'mosaic', 'optic', 'select',
    'holo', 'foil', 'rainbow', 'parallel', 'numbered', 'auto',
    'autograph', 'patch', 'jersey', 'memorabilia', 'rookie ticket',
    'silver', 'gold', 'black', 'red', 'blue', 'green', 'orange',
    'purple', 'pink', 'insert', 'jumbo', 'variation', 'sp', 'ssp',
    'short print', 'update', 'opening day', 'now', 'canvas', 'artist proof'
  ];

  let filtered = cards.filter(card => {
    // Sport match (if hockey, require "hockey" in set name)
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

// Exchange rate endpoint
app.get('/api/exchange-rate', async (req, res) => {
  try {
    // Try to get live exchange rate
    const response = await axios.get('https://api.exchangerate-api.com/v4/latest/USD');
    const rate = response.data.rates.CAD;
    
    res.json({
      success: true,
      rate: rate,
      source: 'live'
    });
  } catch (error) {
    // Fallback to estimated rate
    res.json({
      success: true,
      rate: 1.4,
      source: 'estimated'
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`💳 SportsCardsPro API ready`);
});
