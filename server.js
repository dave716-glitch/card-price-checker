require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ dest: 'uploads/' });

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SPORTSCARDSPRO_TOKEN = process.env.SPORTSCARDSPRO_TOKEN;

app.use(express.static('public'));
app.use(express.json());

// Card recognition endpoint - ONLY identifies the card
app.post('/api/identify-card', upload.single('image'), async (req, res) => {
  try {
    const imagePath = req.file.path;
    const imageData = fs.readFileSync(imagePath);
    const base64Image = imageData.toString('base64');

    console.log('Analyzing card image...');

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
              text: `Analyze this sports card image and extract the following information in JSON format:
{
  "player": "player name",
  "year": "year (e.g., 2024-25)",
  "brand": "card brand (e.g., Upper Deck, Panini)",
  "series": "series name (e.g., Series 1, Prizm)",
  "sport": "sport (hockey, basketball, football, baseball)",
  "parallel": "parallel/variant name if any (e.g., Young Guns, Prizm, Base)"
}

Be precise with the information. If something is unclear, use your best judgment. For hockey rookies in Upper Deck, "Young Guns" is the standard rookie card designation.`
            }
          ],
        },
      ],
    });

    fs.unlinkSync(imagePath);

    const responseText = message.content[0].text;
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    
    if (!jsonMatch) {
      throw new Error('Could not extract card information');
    }

    const cardInfo = JSON.parse(jsonMatch[0]);
    console.log('Card identified:', cardInfo);

    res.json({
      success: true,
      cardInfo: cardInfo
    });

  } catch (error) {
    console.error('Error processing card:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Separate endpoint to get price based on card info
app.post('/api/get-price', async (req, res) => {
  try {
    const cardInfo = req.body;
    console.log('Getting price for card:', cardInfo);
    
    const pricing = await searchSportsCardsPro(cardInfo);
    
    res.json({
      success: true,
      pricing: pricing
    });
    
  } catch (error) {
    console.error('Error getting price:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Exchange rate endpoint
app.get('/api/exchange-rate', async (req, res) => {
  try {
    // Using exchangerate-api.com (free tier, no API key needed)
    const response = await axios.get('https://api.exchangerate-api.com/v4/latest/USD');
    const cadRate = response.data.rates.CAD;
    
    res.json({
      success: true,
      rate: cadRate,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Exchange rate fetch error:', error);
    // Return fallback with error flag
    res.json({
      success: true,
      rate: 1.4,
      timestamp: new Date().toISOString(),
      error: 'Using fallback rate'
    });
  }
});

// Search SportsCardsPro for pricing
async function searchSportsCardsPro(cardInfo) {
  try {
    console.log('Searching for price with card info:', cardInfo);
    
    // Search query without card number
    const query = `${cardInfo.player} ${cardInfo.brand} ${cardInfo.year.split('-')[0]}`.trim();
    console.log('Searching SportsCardsPro with query:', query);
    
    // Search for the card
    const searchUrl = `https://www.sportscardspro.com/api/search?t=${SPORTSCARDSPRO_TOKEN}&q=${encodeURIComponent(query)}`;
    console.log('Fetching from SportsCardsPro...');
    
    const searchResponse = await axios.get(searchUrl);
    const responseData = searchResponse.data;
    
    // Handle different response formats
    let products = [];
    if (Array.isArray(responseData)) {
      products = responseData;
    } else if (responseData && responseData.products) {
      products = responseData.products;
    } else if (responseData && responseData.results) {
      products = responseData.results;
    } else {
      console.log('Unexpected response format');
      return {
        found: false,
        message: 'Unexpected API response format'
      };
    }
    
    if (!products || products.length === 0) {
      console.log('No products found');
      return {
        found: false,
        message: 'Card not found in database'
      };
    }

    console.log(`Found ${products.length} potential matches`);
    
    // Filter variants
    const filteredProducts = filterVariants(products, cardInfo);
    
    if (filteredProducts.length === 0) {
      console.log('No matches after filtering variants');
      return {
        found: false,
        message: 'No matching cards after filtering'
      };
    }

    console.log(`${filteredProducts.length} matches after filtering`);
    
    // If looking for Young Guns, prioritize base Upper Deck set cards
    const queryLower = (cardInfo.parallel || '').toLowerCase();
    const wantsYoungGuns = queryLower === 'young guns' || queryLower === 'young gun';
    
    if (wantsYoungGuns) {
      filteredProducts.sort((a, b) => {
        const aIsBase = a.consoleName.toLowerCase().match(/hockey cards \d{4} upper deck$/);
        const bIsBase = b.consoleName.toLowerCase().match(/hockey cards \d{4} upper deck$/);
        
        if (aIsBase && !bIsBase) return -1;
        if (!aIsBase && bIsBase) return 1;
        return 0;
      });
    }
    
    // Log all filtered products
    console.log('All filtered products (after sorting):');
    filteredProducts.slice(0, 10).forEach((p, i) => {
      console.log(`  ${i + 1}. ${p.productName} - ${p.consoleName}`);
    });

    // Get the best match
    const bestMatch = filteredProducts[0];
    console.log('===== MATCHED CARD =====');
    console.log('Product name:', bestMatch.productName);
    console.log('Set name:', bestMatch.consoleName);
    console.log('Card ID:', bestMatch.id);
    console.log('========================');
    
    // Extract raw price from search results
    const rawPriceString = bestMatch.price1;
    const rawPrice = rawPriceString ? parseFloat(rawPriceString.replace('$', '')) : null;
    
    console.log('===== PRICING =====');
    console.log('Raw price:', rawPrice);
    console.log('===================');
    
    return {
      found: true,
      cardName: bestMatch.productName,
      setName: bestMatch.consoleName,
      price: rawPrice,
      salesVolume: 'N/A',
      cardId: bestMatch.id
    };
    
  } catch (error) {
    console.error('SportsCardsPro search error:', error.message);
    return {
      found: false,
      message: 'Error searching SportsCardsPro',
      error: error.message
    };
  }
}

// Filter out unwanted variants
function filterVariants(products, cardInfo) {
  const queryLower = (cardInfo.parallel || '').toLowerCase();
  
  // Variants to exclude unless specifically requested
  const conditionalVariants = [
    "canvas", "exclusive", "acetate", "deluxe", 
    "outburst", "clear cut", "high gloss", "rainbow",
    "spectrum", "silver", "gold", "platinum",
    "refractor", "prizm", "foil",
    "chrome", "sparkle", "shimmer", "jumbo"
  ];
  
  // Check if user wants a specific variant (but NOT Young Guns, which is base)
  const wantsYoungGuns = queryLower === 'young guns' || queryLower === 'young gun';
  const wantsConditionalVariant = conditionalVariants.some(term => queryLower.includes(term));
  
  return products.filter(product => {
    // Skip products without required fields
    if (!product.productName || !product.consoleName) {
      return false;
    }
    
    const productName = product.productName.toLowerCase();
    const consoleName = product.consoleName.toLowerCase();
    const fullText = productName + ' ' + consoleName;
    
    // ALWAYS filter out oversized
    if (fullText.includes('oversized')) {
      return false;
    }
    
    // If user wants Young Guns (base rookie), accept cards with NO variant designation
    if (wantsYoungGuns) {
      // Check if product name has variant in brackets [...]
      if (product.productName.includes('[')) {
        console.log('Filtering out (has variant in brackets):', product.productName);
        return false;
      }
      
      // Filter out any cards with variant terms in consoleName
      for (const term of conditionalVariants) {
        if (fullText.includes(term)) {
          console.log(`Filtering out variant (${term}):`, product.productName);
          return false;
        }
      }
      
      // This is a base card - keep it!
      return true;
    }
    
    // Filter out other variants unless specifically requested
    if (!wantsConditionalVariant) {
      for (const term of conditionalVariants) {
        if (fullText.includes(term)) {
          console.log(`Filtering out variant (${term}):`, product.productName);
          return false;
        }
      }
    }
    
    return true;
  });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});