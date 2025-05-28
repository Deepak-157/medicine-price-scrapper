const express = require('express');
const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Pharmacy website configurations with actual URLs
const pharmacySites = {
  '1mg': {
    searchUrl: 'https://www.1mg.com/search/all?name=',
    selectors: {
      productCard: '[data-testid="product-card"], .style__product-card___1gbex, .ProductCard__product-card',
      name: '[data-testid="product-name"], .style__product-name___2VZi3, .ProductCard__product-name',
      price: '[data-testid="price"], .style__price-tag___KzOkY, .ProductCard__price',
      link: 'a'
    },
    fallbackSelectors: {
      productCard: '.col-3, .product-card, [class*="product"], [class*="card"]',
      name: '[class*="name"], [class*="title"], h3, h4',
      price: '[class*="price"], [class*="cost"], [class*="amount"]'
    }
  },
  'pharmeasy': {
    searchUrl: 'https://pharmeasy.in/search/all?name=',
    selectors: {
      productCard: '.ProductCard_medicineUnitWrapper__eoLpy, [class*="ProductCard"], [class*="product"]',
      name: '.ProductCard_medicineName__8Yy0C, [class*="medicineName"], [class*="productName"]',
      price: '.ProductCard_ourPrice__yDytt, [class*="ourPrice"], [class*="price"]',
      link: 'a'
    },
    fallbackSelectors: {
      productCard: '[class*="card"], [class*="product"], .medicine-card',
      name: 'h3, h4, [class*="name"], [class*="title"]',
      price: '[class*="price"], [class*="cost"], [class*="amount"]'
    }
  }
};

// Enhanced generic scraper function with fallback selectors
async function scrapePharmacy(pharmacyName, medicineName, useHeadless = true) {
  const config = pharmacySites[pharmacyName];
  if (!config) {
    throw new Error(`Pharmacy ${pharmacyName} not supported`);
  }

  const browser = await puppeteer.launch({
    headless: useHeadless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor'
    ]
  });

  try {
    const page = await browser.newPage();
    
    // Set realistic browser headers
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
    });

    // Handle URL formatting for different sites
    let searchUrl;
    if (pharmacyName === 'pharmeasy') {
      searchUrl = config.searchUrl + encodeURIComponent(medicineName);
    } else {
      searchUrl = config.searchUrl + encodeURIComponent(medicineName);
    }

    console.log(`Scraping ${pharmacyName}: ${searchUrl}`);
    
    await page.goto(searchUrl, { 
      waitUntil: 'domcontentloaded', 
      timeout: 45000 
    });

    // Wait for dynamic content to load
    await page.waitForTimeout(5000);

    // Try to handle popups/modals
    try {
      await page.evaluate(() => {
        // Close any modal/popup if present
        const closeButtons = document.querySelectorAll('[class*="close"], [class*="dismiss"], .modal-close, [aria-label*="close"]');
        closeButtons.forEach(btn => btn.click());
      });
    } catch (e) {
      // Ignore popup handling errors
    }

    const medicines = await page.evaluate((config, pharmacyName) => {
      const products = [];
      
      // Try primary selectors first, then fallbacks
      const selectorSets = [config.selectors];
      if (config.fallbackSelectors) {
        selectorSets.push(config.fallbackSelectors);
      }

      for (const selectors of selectorSets) {
        const productCards = document.querySelectorAll(selectors.productCard);
        
        if (productCards.length > 0) {
          console.log(`Found ${productCards.length} product cards with selector: ${selectors.productCard}`);
          
          productCards.forEach((card, index) => {
            if (index >= 15) return; // Limit to first 2 results per website

            // Try multiple name selectors
            let nameElement = card.querySelector(selectors.name);
            if (!nameElement) {
              const nameSelectors = ['h3', 'h4', '.title', '[class*="name"]', '[class*="title"]'];
              for (const nameSelector of nameSelectors) {
                nameElement = card.querySelector(nameSelector);
                if (nameElement) break;
              }
            }

            // Try multiple price selectors
            let priceElement = card.querySelector(selectors.price);
            if (!priceElement) {
              const priceSelectors = ['[class*="price"]', '[class*="cost"]', '[class*="amount"]', '.price', '.cost'];
              for (const priceSelector of priceSelectors) {
                priceElement = card.querySelector(priceSelector);
                if (priceElement) break;
              }
            }

            const linkElement = card.querySelector(selectors.link) || card.querySelector('a');

            if (nameElement && priceElement) {
              const name = nameElement.textContent.trim();
              const priceText = priceElement.textContent.trim();
              
              // Enhanced price extraction
              const priceMatch = priceText.match(/₹?\s*(\d+(?:,\d+)*(?:\.\d{2})?)/);
              const price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : 0;

              if (name && !isNaN(price) && price > 0) {
                products.push({
                  name,
                  price,
                  priceText,
                  link: linkElement ? linkElement.href : '',
                  pharmacy: pharmacyName,
                  selector: selectors.productCard
                });
              }
            }
          });

          // If we found products, break out of selector loop
          if (products.length > 0) break;
        }
      }

      return products;
    }, config, pharmacyName);

    console.log(`${pharmacyName}: Found ${medicines.length} medicines`);
    return medicines;

  } catch (error) {
    console.error(`Error scraping ${pharmacyName}:`, error.message);
    return [];
  } finally {
    await browser.close();
  }
}

// Enhanced axios-based scraper with better error handling
async function scrapeWithAxios(pharmacyName, medicineName) {
  const config = pharmacySites[pharmacyName];
  if (!config) {
    throw new Error(`Pharmacy ${pharmacyName} not supported`);
  }

  try {
    // Handle URL formatting for different sites
    let searchUrl;
    if (pharmacyName === 'pharmeasy') {
      searchUrl = config.searchUrl + encodeURIComponent(medicineName);
    } else {
      searchUrl = config.searchUrl + encodeURIComponent(medicineName);
    }

    console.log(`Axios scraping ${pharmacyName}: ${searchUrl}`);

    const response = await axios.get(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Cache-Control': 'max-age=0'
      },
      timeout: 15000,
      maxRedirects: 5
    });

    const $ = cheerio.load(response.data);
    const medicines = [];

    // Try primary selectors first, then fallbacks
    const selectorSets = [config.selectors];
    if (config.fallbackSelectors) {
      selectorSets.push(config.fallbackSelectors);
    }

    for (const selectors of selectorSets) {
      const productCards = $(selectors.productCard);
      
      if (productCards.length > 0) {
        console.log(`Found ${productCards.length} product cards with selector: ${selectors.productCard}`);
        
        productCards.each((index, element) => {
          if (index >= 15) return; // Limit to first 2 results per website

          const $element = $(element);
          
          // Try to find name element
          let name = $element.find(selectors.name).first().text().trim();
          if (!name) {
            // Try fallback name selectors
            const nameSelectors = ['h3', 'h4', '.title', '[class*="name"]', '[class*="title"]'];
            for (const nameSelector of nameSelectors) {
              name = $element.find(nameSelector).first().text().trim();
              if (name) break;
            }
          }

          // Try to find price element
          let priceText = $element.find(selectors.price).first().text().trim();
          if (!priceText) {
            // Try fallback price selectors
            const priceSelectors = ['[class*="price"]', '[class*="cost"]', '[class*="amount"]', '.price', '.cost'];
            for (const priceSelector of priceSelectors) {
              priceText = $element.find(priceSelector).first().text().trim();
              if (priceText) break;
            }
          }

          const link = $element.find(selectors.link).first().attr('href') || 
                      $element.find('a').first().attr('href') || '';

          if (name && priceText) {
            // Enhanced price extraction
            const priceMatch = priceText.match(/₹?\s*(\d+(?:,\d+)*(?:\.\d{2})?)/);
            const price = priceMatch ? parseFloat(priceMatch[1].replace(/,/g, '')) : 0;

            if (price > 0) {
              const fullLink = link && !link.startsWith('http') ? 
                             `https://${pharmacyName === '1mg' ? '1mg.com' : pharmacyName + '.com'}${link}` : 
                             link;

              medicines.push({
                name,
                price,
                priceText,
                link: fullLink,
                pharmacy: pharmacyName,
                method: 'axios'
              });
            }
          }
        });

        // If we found products, break out of selector loop
        if (medicines.length > 0) break;
      }
    }

    console.log(`${pharmacyName}: Found ${medicines.length} medicines via axios`);
    return medicines;

  } catch (error) {
    console.error(`Error scraping ${pharmacyName} with axios:`, error.message);
    
    // If axios fails due to blocking, suggest using puppeteer
    if (error.response && (error.response.status === 403 || error.response.status === 429)) {
      console.log(`${pharmacyName} blocked axios request, try puppeteer method`);
    }
    
    return [];
  }
}

// Compare prices across all pharmacies with enhanced error handling
async function compareMedicinePrices(medicineName, method = 'puppeteer') {
  const results = {};
  const scrapeFunction = method === 'axios' ? scrapeWithAxios : scrapePharmacy;
  const errors = {};

  console.log(`\n🔍 Starting price comparison for "${medicineName}" using ${method} method\n`);

  // Scrape all pharmacies with proper error handling
  const promises = Object.keys(pharmacySites).map(async (pharmacy) => {
    try {
      console.log(`⏳ Scraping ${pharmacy}...`);
      const medicines = await scrapeFunction(pharmacy, medicineName);
      results[pharmacy] = medicines;
      console.log(`✅ ${pharmacy}: Found ${medicines.length} results`);
    } catch (error) {
      console.error(`❌ Failed to scrape ${pharmacy}:`, error.message);
      results[pharmacy] = [];
      errors[pharmacy] = error.message;
    }
  });

  await Promise.all(promises);

  // Combine and sort results
  const allMedicines = [];
  Object.entries(results).forEach(([pharmacy, medicines]) => {
    allMedicines.push(...medicines);
  });

  // Sort by price (lowest first)
  allMedicines.sort((a, b) => a.price - b.price);

  // Get successful scrapes count
  const successfulScrapes = Object.values(results).filter(arr => arr.length > 0).length;

  console.log(`\n📊 Comparison complete: Found ${allMedicines.length} total results from ${successfulScrapes} pharmacies\n`);

  return {
    query: medicineName,
    method: method,
    totalResults: allMedicines.length,
    successfulScrapes: successfulScrapes,
    pharmacies: results,
    bestDeals: allMedicines.slice(0, 10), // Top 10 cheapest
    comparison: generateComparison(results),
    errors: Object.keys(errors).length > 0 ? errors : null,
    suggestions: generateSuggestions(results, method)
  };
}

// Generate suggestions based on scraping results
function generateSuggestions(results, method) {
  const suggestions = [];
  const totalResults = Object.values(results).reduce((sum, arr) => sum + arr.length, 0);
  
  if (totalResults === 0) {
    suggestions.push("No results found. Try:");
    suggestions.push("- Using a different medicine name or brand");
    suggestions.push("- Switching to 'puppeteer' method for better reliability");
    suggestions.push("- Checking if the medicine name is spelled correctly");
  } else if (totalResults < 5) {
    suggestions.push("Limited results found. Consider:");
    suggestions.push("- Trying alternative medicine names or generic versions");
    if (method === 'axios') {
      suggestions.push("- Using 'puppeteer' method for more comprehensive scraping");
    }
  }
  
  const failedScrapes = Object.values(results).filter(arr => arr.length === 0).length;
  if (failedScrapes > 0 && method === 'axios') {
    suggestions.push("Some sites blocked axios requests - try 'puppeteer' method for better success rate");
  }
  
  return suggestions.length > 0 ? suggestions : null;
}

// Generate comparison statistics
function generateComparison(results) {
  const comparison = {};
  
  Object.entries(results).forEach(([pharmacy, medicines]) => {
    if (medicines.length > 0) {
      const prices = medicines.map(m => m.price);
      comparison[pharmacy] = {
        count: medicines.length,
        minPrice: Math.min(...prices),
        maxPrice: Math.max(...prices),
        avgPrice: parseFloat((prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(2))
      };
    }
  });

  return comparison;
}

// API Routes

// Health check
app.get('/', (req, res) => {
  res.json({
    message: 'Medicine Price Scraper API',
    version: '1.0.0',
    endpoints: {
      '/api/search/:medicine': 'Search for medicine prices'
    }
  });
});

// Quick search - only endpoint
app.get('/api/search/:medicine', async (req, res) => {
  const { medicine } = req.params;
  const { method = 'axios' } = req.query; // Default to faster axios method for quick search

  try {
    const results = await compareMedicinePrices(medicine, method);
    res.json(results);
  } catch (error) {
    res.status(500).json({
      error: 'Search failed',
      message: error.message
    });
  }
});

// Batch search for multiple medicines
app.post('/api/batch-search', async (req, res) => {
  const { medicines, method = 'axios' } = req.body;

  if (!Array.isArray(medicines) || medicines.length === 0) {
    return res.status(400).json({
      error: 'Please provide an array of medicine names'
    });
  }

  if (medicines.length > 5) {
    return res.status(400).json({
      error: 'Maximum 5 medicines allowed per batch request'
    });
  }

  try {
    const results = {};
    
    for (const medicine of medicines) {
      results[medicine] = await compareMedicinePrices(medicine, method);
      // Add small delay between requests to avoid being blocked
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    res.json({
      batch_results: results,
      processed: medicines.length
    });
  } catch (error) {
    res.status(500).json({
      error: 'Batch search failed',
      message: error.message
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    error: 'Internal server error',
    message: error.message
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    available_endpoints: [
      'GET /',
      'GET /api/search/:medicine'
    ]
  });
});

app.listen(PORT, () => {
  console.log(`Medicine Price Scraper API running on port ${PORT}`);
  console.log(`Access the API at: http://localhost:${PORT}`);
  console.log(`\nExample usage:`);
  console.log(`- Search: GET /api/search/paracetamol`);
  console.log(`- Compare: GET /api/compare/crocin`);
  console.log(`- Specific pharmacy: GET /api/pharmacy/1mg/aspirin`);
});

module.exports = app;
