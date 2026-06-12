/**
 * CoStage Scraping Backend
 *
 * Express server that headlessly renders JS-heavy furniture sites (RH, CB2, West Elm etc)
 * using Puppeteer, then extracts structured product data for free — no LLM, no API key —
 * via JSON-LD parsing plus heuristic DOM scraping (cheerio).
 *
 * Endpoints:
 *   POST /scrape        { url }  → { products[], source, category }
 *   POST /scrape-page   { html, source } → { products[] }  (if you already have the HTML)
 *   GET  /health
 *
 * Setup:
 *   npm install express puppeteer cheerio cors dotenv
 *   node server.js
 */

import express    from 'express';
import cors       from 'cors';
import puppeteer  from 'puppeteer';
import * as cheerio from 'cheerio';
import dotenv     from 'dotenv';

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Retailer configs ──────────────────────────────────────────────────────────
// Each retailer needs slightly different wait/scroll strategies because they
// load products differently (infinite scroll, pagination, lazy images, etc.)

const RETAILER_CONFIGS = {
  'rh.com': {
    waitFor:    '.product-line-item, [data-testid="product-card"], .product-card',
    scrollPasses: 3,
    extraWait:  3000,
    blockAds:   true,
  },
  'cb2.com': {
    waitFor:    '.product-tile, [class*="ProductTile"], [class*="product-grid"]',
    scrollPasses: 2,
    extraWait:  2000,
    blockAds:   true,
  },
  'westelm.com': {
    waitFor:    '[class*="product-tile"], [class*="ProductCard"]',
    scrollPasses: 2,
    extraWait:  2500,
    blockAds:   true,
  },
  'crateandbarrel.com': {
    waitFor:    '[class*="product-tile"], .product-component',
    scrollPasses: 2,
    extraWait:  2000,
    blockAds:   true,
  },
  'article.com': {
    waitFor:    '[class*="ProductCard"], [class*="product-card"]',
    scrollPasses: 2,
    extraWait:  1500,
    blockAds:   true,
  },
  'ikea.com': {
    waitFor:    '[class*="plp-fragment-wrapper"], .pip-product-compact',
    scrollPasses: 4,
    extraWait:  3000,
    blockAds:   true,
  },
  // Default for unknown retailers
  'default': {
    waitFor:    null,  // just wait for network idle
    scrollPasses: 2,
    extraWait:  2000,
    blockAds:   false,
  },
};

// ── Main scrape endpoint ──────────────────────────────────────────────────────

// ── Shared renderer ────────────────────────────────────────────────────────────
// Headlessly renders a retailer page with Puppeteer and pulls out the raw
// signals (JSON-LD, og:meta, grid HTML) that the free extractors below parse.

async function renderPage(url, logTag) {
  const hostname = new URL(url).hostname.replace('www.', '');
  const config   = RETAILER_CONFIGS[hostname] || RETAILER_CONFIGS['default'];

  console.log(`[${logTag}] ${url}`);
  console.log(`[${logTag}] config: ${JSON.stringify(config)}`);

  let browser;
  try {
    // ── Launch Puppeteer ────────────────────────────────────────────────────
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
    });

    const page = await browser.newPage();

    // Realistic viewport and user agent
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/120.0.0.0 Safari/537.36'
    );

    // Block ads, tracking, and heavy media to speed up load
    if (config.blockAds) {
      await page.setRequestInterception(true);
      page.on('request', req => {
        const type = req.resourceType();
        const url  = req.url();
        const isAd = ['doubleclick','googlesyndication','googletagmanager',
                      'facebook.com/tr','analytics','hotjar','intercom']
                     .some(d => url.includes(d));
        // Block ads, fonts (optional), but allow images and scripts
        if (isAd || type === 'font') req.abort();
        else req.continue();
      });
    }

    // ── Navigate ────────────────────────────────────────────────────────────
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout:   30000,
    });

    // Wait for product elements to appear
    if (config.waitFor) {
      try {
        await page.waitForSelector(config.waitFor, { timeout: 8000 });
      } catch {
        console.log(`[${logTag}] Selector timeout — proceeding anyway`);
      }
    }

    // Extra wait for JS rendering
    await new Promise(r => setTimeout(r, config.extraWait));

    // ── Scroll to trigger lazy loading ──────────────────────────────────────
    for (let i = 0; i < config.scrollPasses; i++) {
      await autoScroll(page);
      await new Promise(r => setTimeout(r, 800));
    }

    // ── Extract page signals ────────────────────────────────────────────────
    const pageData = await page.evaluate(() => {
      const products = [];

      // Strategy 1: Look for structured product data in JSON-LD
      const jsonLdScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      for (const script of jsonLdScripts) {
        try {
          const data = JSON.parse(script.textContent);
          const items = Array.isArray(data) ? data : [data];
          for (const item of items) {
            if (item['@type'] === 'Product') {
              products.push({
                source: 'jsonld',
                name:   item.name,
                price:  item.offers?.price ? `$${item.offers.price}` : item.offers?.priceSpecification?.price,
                image:  Array.isArray(item.image) ? item.image[0] : item.image,
                url:    item.url || window.location.href,
                description: item.description,
                sku:    item.sku,
              });
            }
            // ItemList
            if (item['@type'] === 'ItemList' && item.itemListElement) {
              for (const el of item.itemListElement) {
                if (el.item?.['@type'] === 'Product') {
                  products.push({ source:'jsonld', ...el.item });
                }
              }
            }
          }
        } catch {}
      }

      // Strategy 2: og:* and meta tags for single product pages
      const ogTitle   = document.querySelector('meta[property="og:title"]')?.content;
      const ogImage   = document.querySelector('meta[property="og:image"]')?.content;
      const ogUrl     = document.querySelector('meta[property="og:url"]')?.content;
      const ogPrice   = document.querySelector('meta[property="product:price:amount"]')?.content
                     || document.querySelector('meta[property="og:price:amount"]')?.content;

      // Strategy 3: Raw HTML for the heuristic DOM scraper to parse
      // Trim to product grid area to keep things fast
      const gridSelectors = [
        '[class*="product-grid"]', '[class*="ProductGrid"]',
        '[class*="product-list"]', '[class*="ProductList"]',
        '[class*="plp"]', '[class*="catalog"]',
        'main', '#main-content', '.main-content',
      ];
      let gridHTML = '';
      for (const sel of gridSelectors) {
        const el = document.querySelector(sel);
        if (el && el.innerHTML.length > 500) {
          gridHTML = el.innerHTML.substring(0, 60000); // cap at 60k chars
          break;
        }
      }
      if (!gridHTML) gridHTML = document.body.innerHTML.substring(0, 60000);

      return {
        jsonLdProducts: products,
        ogMeta:  { title: ogTitle, image: ogImage, url: ogUrl, price: ogPrice },
        bodyText: document.body.innerText.substring(0, 20000),
        gridHTML,
        pageTitle: document.title,
        pageUrl:   window.location.href,
      };
    });

    console.log(`[${logTag}] JSON-LD products found: ${pageData.jsonLdProducts.length}`);
    console.log(`[${logTag}] Grid HTML length: ${pageData.gridHTML.length}`);

    return { hostname, pageData };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ── Category/listing scrape — many products ───────────────────────────────────

app.post('/scrape', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  try {
    const { hostname, pageData } = await renderPage(url, 'scrape');
    const products = extractProductsFree(pageData, url);

    res.json({
      success:  true,
      source:   hostname,
      url,
      products,
      debug: {
        jsonLdCount: pageData.jsonLdProducts.length,
        htmlLength:  pageData.gridHTML.length,
      },
    });

  } catch (err) {
    console.error('[scrape] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Single product page scrape — one item, picked by the user ────────────────

app.post('/scrape-product', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  try {
    const { hostname, pageData } = await renderPage(url, 'scrape-product');
    const product = extractSingleProductFree(pageData, url);

    if (!product) {
      return res.status(422).json({ error: 'Could not find product details on that page. Try the exact product page URL.' });
    }

    res.json({ success: true, source: hostname, url, product });

  } catch (err) {
    console.error('[scrape-product] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Free product extraction (no LLM, no API key) ──────────────────────────────
// Two passes, both rule-based:
//   1. JSON-LD  — parse schema.org Product data already pulled from the page
//   2. Heuristic DOM scrape via cheerio — find card-like elements with an
//      image + price + title when JSON-LD isn't present or comes up short

const CATEGORY_KEYWORDS = [
  ['sectional',     'sofa'],
  ['sofa',          'sofa'],
  ['loveseat',      'sofa'],
  ['armchair',      'armchair'],
  ['accent chair',  'armchair'],
  ['lounge chair',  'armchair'],
  ['coffee table',  'coffee table'],
  ['side table',    'coffee table'],
  ['dining table',  'dining table'],
  ['dining chair',  'dining chair'],
  ['bed frame',     'bed'],
  ['bed',           'bed'],
  ['nightstand',    'nightstand'],
  ['dresser',       'dresser'],
  ['chest of drawers', 'dresser'],
  ['desk',          'desk'],
  ['bookshelf',     'bookshelf'],
  ['bookcase',      'bookshelf'],
  ['tv stand',      'tv unit'],
  ['media console', 'tv unit'],
  ['rug',           'rug'],
  ['lamp',          'lamp'],
];

const STYLE_KEYWORDS = [
  ['mid-century',  'mid-century'],
  ['mid century',  'mid-century'],
  ['scandinavian', 'scandinavian'],
  ['industrial',   'industrial'],
  ['traditional',  'traditional'],
  ['transitional', 'transitional'],
  ['modern',       'modern'],
  ['contemporary', 'modern'],
];

// Rough realistic footprints per category, in metres [width, depth, height]
const CATEGORY_DIMENSIONS = {
  'sofa':          [2.10, 0.95, 0.85],
  'armchair':      [0.85, 0.90, 0.85],
  'coffee table':  [1.20, 0.65, 0.40],
  'dining table':  [1.80, 0.90, 0.75],
  'dining chair':  [0.50, 0.55, 0.85],
  'bed':           [1.60, 2.10, 1.10],
  'nightstand':    [0.50, 0.40, 0.60],
  'dresser':       [1.40, 0.50, 0.85],
  'desk':          [1.30, 0.65, 0.75],
  'bookshelf':     [0.90, 0.35, 1.85],
  'tv unit':       [1.60, 0.45, 0.50],
  'rug':           [2.40, 1.70, 0.02],
  'lamp':          [0.35, 0.35, 1.55],
  'other':         [1.00, 0.80, 0.80],
};

function guessFromKeywords(text, table, fallback) {
  const lower = text.toLowerCase();
  for (const [needle, value] of table) {
    if (lower.includes(needle)) return value;
  }
  return fallback;
}

function slugify(text, fallback) {
  const slug = (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return slug || fallback;
}

function parsePrice(raw) {
  if (raw == null) return { price: null, currency: 'USD' };
  const str = String(raw).trim();
  const match = str.match(/[\d,.]+/);
  if (!match) return { price: str || null, currency: 'USD' };
  const num = match[0];
  const currency = str.includes('£') ? 'GBP' : str.includes('€') ? 'EUR' : 'USD';
  const symbol   = currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : '$';
  return { price: `${symbol}${num}`, currency };
}

function buildProduct({ name, price, imageUrl, productUrl, description, sku }, hostname, seen) {
  if (!name || !imageUrl) return null;

  const id = slugify(sku || name, `${hostname}-${seen.size}`);
  if (seen.has(id)) return null;
  seen.add(id);

  const haystack   = `${name} ${description || ''}`;
  const category   = guessFromKeywords(haystack, CATEGORY_KEYWORDS, 'other');
  const style      = guessFromKeywords(haystack, STYLE_KEYWORDS, 'other');
  const [w, d, h]  = CATEGORY_DIMENSIONS[category] || CATEGORY_DIMENSIONS.other;
  const { price: priceStr, currency } = parsePrice(price);

  return {
    id,
    name: name.trim(),
    price: priceStr,
    currency,
    dimensions: { width: w, depth: d, height: h, unit: 'm' },
    category,
    style,
    materials: [],
    colors: [],
    imageUrls: [imageUrl],
    productUrl: productUrl || null,
    description: description || null,
    sku: sku || null,
    glbReady: false,
  };
}

function extractFromJsonLd(jsonLdProducts, hostname, seen) {
  const out = [];
  for (const item of jsonLdProducts) {
    const product = buildProduct({
      name:        item.name,
      price:       item.price ?? item.offers?.price ?? item.offers?.priceSpecification?.price,
      imageUrl:    Array.isArray(item.image) ? item.image[0] : item.image,
      productUrl:  item.url,
      description: item.description,
      sku:         item.sku,
    }, hostname, seen);
    if (product) out.push(product);
  }
  return out;
}

// Heuristic: find the smallest repeated container that wraps an <img>, a
// price-looking string ($123, £1,200, €99.00) and some title-ish text/link.
function extractFromHtml(gridHTML, pageUrl, hostname, seen) {
  const $ = cheerio.load(gridHTML);
  const priceRe = /[$£€]\s?\d[\d,.]*/;
  const out = [];

  $('img').each((_, img) => {
    if (out.length + seen.size >= 20) return false;

    const $img = $(img);
    const imageUrl = $img.attr('src') || $img.attr('data-src') || $img.attr('data-lazy-src');
    if (!imageUrl || imageUrl.startsWith('data:')) return;

    // Walk up to find a card-sized container that also holds a price
    let $card = $img;
    let priceText = null;
    for (let i = 0; i < 6 && $card.length; i++) {
      $card = $card.parent();
      const text = $card.text();
      const match = text.match(priceRe);
      if (match) { priceText = match[0]; break; }
    }
    if (!priceText) return;

    const $link = $card.find('a[href]').first();
    const href  = $link.attr('href');
    const productUrl = href
      ? (href.startsWith('http') ? href : new URL(href, pageUrl).toString())
      : null;

    const name = ($img.attr('alt') || $link.attr('title') || $link.text() || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!name) return;

    const resolvedImage = imageUrl.startsWith('http') ? imageUrl : new URL(imageUrl, pageUrl).toString();

    const product = buildProduct({
      name,
      price: priceText,
      imageUrl: resolvedImage,
      productUrl,
      description: null,
      sku: null,
    }, hostname, seen);
    if (product) out.push(product);
  });

  return out;
}

function extractProductsFree(pageData, originalUrl) {
  const hostname = new URL(originalUrl).hostname.replace('www.', '');
  const seen = new Set();

  const fromJsonLd = extractFromJsonLd(pageData.jsonLdProducts, hostname, seen);
  console.log(`[extract] JSON-LD yielded ${fromJsonLd.length} products`);

  let products = fromJsonLd;
  if (products.length < 6) {
    const fromHtml = extractFromHtml(pageData.gridHTML, pageData.pageUrl || originalUrl, hostname, seen);
    console.log(`[extract] Heuristic DOM scrape yielded ${fromHtml.length} more products`);
    products = products.concat(fromHtml);
  }

  return products.slice(0, 20);
}

// Single-product page: prefer JSON-LD Product, then og:meta + a price found in
// the page body text. Much higher-confidence than grid heuristics because a
// product page describes exactly one item.
function extractSingleProductFree(pageData, originalUrl) {
  const hostname = new URL(originalUrl).hostname.replace('www.', '');
  const seen = new Set();

  if (pageData.jsonLdProducts.length > 0) {
    const item = pageData.jsonLdProducts[0];
    const jsonLdPrice = item.price ?? item.offers?.price ?? item.offers?.priceSpecification?.price;
    const bodyPrice   = (pageData.bodyText || '').match(/[$£€]\s?\d[\d,.]*/)?.[0];
    const product = buildProduct({
      name:        item.name,
      price:       jsonLdPrice ?? bodyPrice,
      imageUrl:    Array.isArray(item.image) ? item.image[0] : item.image,
      productUrl:  item.url || originalUrl,
      description: item.description,
      sku:         item.sku,
    }, hostname, seen);
    if (product) return product;
  }

  const og = pageData.ogMeta || {};
  if (og.title && og.image) {
    const priceMatch = (og.price && `$${og.price}`) || (pageData.bodyText || '').match(/[$£€]\s?\d[\d,.]*/)?.[0];
    return buildProduct({
      name:        og.title,
      price:       priceMatch,
      imageUrl:    og.image,
      productUrl:  og.url || originalUrl,
      description: null,
      sku:         null,
    }, hostname, seen);
  }

  return null;
}

// ── HTML-only endpoint (if you already have the page HTML) ────────────────────

app.post('/scrape-page', async (req, res) => {
  const { html, source, url } = req.body;
  if (!html) return res.status(400).json({ error: 'html required' });

  try {
    const pageData = {
      jsonLdProducts: [],
      gridHTML: html.substring(0, 60000),
      pageTitle: source || 'furniture page',
      pageUrl: url || `https://${source}`,
    };

    const products = extractProductsFree(pageData, url || `https://${source}`);
    res.json({ success: true, source, products });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────

app.get('/health', (_, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ── Catalogue endpoint ────────────────────────────────────────────────────────

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname_srv = dirname(fileURLToPath(import.meta.url));

app.get('/catalogue', (req, res) => {
  const source = req.query.source || 'rove-concepts';
  const fileMap = {
    'west-elm':    'west-elm-catalogue.json',
    'soho-home':   'soho-home-catalogue.json',
    'rove-concepts': 'rove-concepts-catalogue.json',
    'claude-home': 'claude-home-catalogue.json',
    'soho-home-lighting': 'soho-home-lighting-catalogue.json',
    'povison': 'povison-catalogue.json',
  };
  const fileName = fileMap[source] || 'rove-concepts-catalogue.json';
  const catPath = join(__dirname_srv, '..', fileName);
  if (!existsSync(catPath)) return res.status(404).json({ error: `Catalogue not found: ${fileName}` });
  res.setHeader('Content-Type', 'application/json');
  res.send(readFileSync(catPath));
});

// ── Auto-scroll helper ────────────────────────────────────────────────────────

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let totalHeight = 0;
      const distance  = 400;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= document.body.scrollHeight - window.innerHeight) {
          clearInterval(timer);
          window.scrollTo(0, 0); // scroll back to top
          resolve();
        }
      }, 120);
    });
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`CoStage scraping backend running on http://localhost:${PORT}`);
  console.log('Extraction: free, rule-based (JSON-LD + heuristic DOM scrape) — no API key required');
});
