const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
require('dotenv').config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Identify card from image using Claude
app.post('/api/identify-card', upload.single('image'), async (req, res) => {
  try {
    const imageBuffer = req.file.buffer;
    const base64Image = imageBuffer.toString('base64');
    
const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
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
  "player": "player name(s)",
  "year": "year or year range (e.g., 2024-25)",
  "brand": "card manufacturer",
  "series": "series/set name",
  "cardNumber": "card number",
  "sport": "sport type",
  "autographed": true or false,
  "serialNumber": "serial number if present (e.g., /50, 14/99)",
  "parallel": "parallel type if present (e.g., Gold, Refractor, Orange)"
}

IMPORTANT:
- Look for autographs (signatures on the card) and text like "CERTIFIED AUTOGRAPH"
- Look for serial numbers (usually format like 14/50, meaning card 14 of 50 made)
- Look for parallel/variant types (Gold, Refractor, Orange, etc.) - often indicated by border color or text
- Be precise with the year format, brand name, and series
- If it's a checklist card with multiple players, include both names separated by " & "
- Look carefully for card numbers - they are often small and at the bottom of the card
- If you truly cannot find something, return "Not visible" for cardNumber or null for optional fields
Only return the JSON, nothing else.`
            }
          ],
        },
      ],
    });
    
// Extract JSON from response (handle markdown code blocks)
let responseText = message.content[0].text;
// Remove markdown code blocks if present
responseText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
const cardInfo = JSON.parse(responseText);    res.json({ success: true, cardInfo });
  } catch (error) {
    console.error('Error identifying card:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Search eBay for sold listings
app.post('/api/search-ebay', async (req, res) => {
  try {
    const { cardInfo } = req.body;
    
    // Build search query
const searchQuery = `${cardInfo.year} ${cardInfo.brand} ${cardInfo.series} ${cardInfo.player}`;
console.log('\n========== EBAY SEARCH ==========');
console.log('Search Query:', searchQuery);
console.log('Card Info:', cardInfo);
console.log('==================================\n');
    // eBay Finding API endpoint
const ebayUrl = 'https://svcs.ebay.com/services/search/FindingService/v1';
    const params = {
      'OPERATION-NAME': 'findCompletedItems',
      'SERVICE-VERSION': '1.0.0',
      'SECURITY-APPNAME': process.env.EBAY_APP_ID,
      'RESPONSE-DATA-FORMAT': 'JSON',
      'REST-PAYLOAD': '',
      'keywords': searchQuery,
      'sortOrder': 'EndTimeSoonest',
      'paginationInput.entriesPerPage': '100',
      'itemFilter(0).name': 'SoldItemsOnly',
      'itemFilter(0).value': 'true',
      'itemFilter(1).name': 'Condition',
      'itemFilter(1).value': '3000', // Used condition
    };

    const response = await axios.get(ebayUrl, { params });
    
    const items = response.data.findCompletedItemsResponse[0].searchResult[0].item || [];
    console.log('Total items found by eBay:', items.length);
if (items.length > 0) {
  console.log('First 3 item titles:', items.slice(0, 3).map(i => i.title[0]));
}
   console.log('eBay Response Status:', response.data.findCompletedItemsResponse[0].ack[0]);
console.log('Total items found:', items.length);
if (items.length > 0) {
  console.log('First item title:', items[0].title[0]);
} 
    // Filter out graded cards
    const gradingTerms = ['psa', 'bgs', 'sgc', 'cgc', 'graded', 'gem', 'mint 10', 'bccg', 'hga', 'slab'];
    
    const rawCards = items.filter(item => {
      const title = item.title[0].toLowerCase();
      return !gradingTerms.some(term => title.includes(term));
    });
    
    console.log('Items after filtering graded cards:', rawCards.length);
if (rawCards.length > 0) {
  console.log('First raw card:', rawCards[0].title[0]);
}

    // Extract just the sold prices (last 10)
    const soldPrices = rawCards
      .slice(0, 10)
      .map(item => ({
        price: parseFloat(item.sellingStatus[0].currentPrice[0].__value__),
        date: item.listingInfo[0].endTime[0].split('T')[0],
        currency: item.sellingStatus[0].currentPrice[0]['@currencyId']
      }));

    res.json({ 
      success: true, 
      soldPrices,
      totalFound: rawCards.length 
    });
} catch (error) {
    console.error('Error searching eBay:', error.message);
    if (error.response) {
console.error('eBay API Response:', JSON.stringify(error.response.data, null, 2));
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});