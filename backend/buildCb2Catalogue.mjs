#!/usr/bin/env node
/**
 * CB2 catalogue builder — Puppeteer with API interception
 * Strategy:
 *   1. Navigate each category listing page.
 *   2. Intercept XHR/fetch responses — CB2 loads products via an internal
 *      JSON API. Capture the first response that contains a recognisable
 *      product array (items[].name + price).
 *   3. If no API response is captured, fall back to DOM extraction of
 *      product cards using JSON-LD or og:* meta tags.
 *   4. For each product, visit its page and parse JSON-LD Product schema
 *      for dimensions, description, colors.
 *
 * Usage:  node scrapers/buildCb2Catalogue.mjs
 *         node scrapers/buildCb2Catalogue.mjs --resume
 * Output: cb2-catalogue.json  (repo root)
 */

import puppeteer from 'puppeteer';
import { writeFile, readFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH  = path.join(__dirname, '..', 'cb2-catalogue.json');
const LOG_PATH  = path.join(__dirname, 'cb2-scrape.log');
const RESUME    = process.argv.includes('--resume');
const BASE      = 'https://www.cb2.com';
const MAX_PER_CAT = 20;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const delay = ms => new Promise(r => setTimeout(r, ms + Math.random() * 200));

// ── Categories ────────────────────────────────────────────────────────────────

const CATEGORIES = [
  { room: 'living room', cat: 'sofa',         paths: ['/furniture/sofas', '/furniture/sectionals'] },
  { room: 'living room', cat: 'armchair',     paths: ['/furniture/accent-chairs'] },
  { room: 'living room', cat: 'coffee table', paths: ['/furniture/coffee-tables'] },
  { room: 'living room', cat: 'side table',   paths: ['/furniture/side-tables', '/furniture/end-tables'] },
  { room: 'living room', cat: 'tv unit',      paths: ['/furniture/media-consoles-and-tv-stands', '/furniture/media-storage'] },
  { room: 'bedroom',     cat: 'bed',          paths: ['/furniture/beds', '/furniture/bed-frames'] },
  { room: 'bedroom',     cat: 'nightstand',   paths: ['/furniture/nightstands'] },
  { room: 'bedroom',     cat: 'dresser',      paths: ['/furniture/dressers-and-chests'] },
  { room: 'dining room', cat: 'dining table', paths: ['/furniture/dining-tables'] },
  { room: 'dining room', cat: 'dining chair', paths: ['/furniture/dining-chairs'] },
  { room: 'dining room', cat: 'sideboard',    paths: ['/furniture/sideboards-and-buffets'] },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(t) { return (t||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,''); }
function stripHtml(html) { return (html||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim(); }

async function log(msg) {
  console.log(msg);
  await appendFile(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`).catch(()=>{});
}

// ── Look for product arrays in an intercepted JSON payload ────────────────────

function findProductsInPayload(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 8) return null;
  if (Array.isArray(obj)) {
    // Heuristic: array of objects with name/title and some price signal
    if (obj.length > 0 && typeof obj[0] === 'object') {
      const sample = obj[0];
      const keys = Object.keys(sample).map(k => k.toLowerCase());
      if ((keys.includes('name') || keys.includes('title') || keys.includes('displayname')) &&
          (keys.includes('price') || keys.includes('listprice') || keys.includes('saleprice') || keys.includes('pricerange') || keys.includes('offers'))) {
        if (obj.length >= 2) return obj;
      }
    }
  }
  for (const val of Object.values(obj)) {
    const found = findProductsInPayload(val, depth + 1);
    if (found) return found;
  }
  return null;
}

// ── Normalise a product record from the API payload ───────────────────────────

function normaliseApiProduct(raw) {
  // Try various field name conventions
  const name  = raw.name || raw.title || raw.displayName || raw.productName || null;
  if (!name) return null;

  const priceNum =
    raw.price?.low  ?? raw.listPrice ?? raw.regularPrice ?? raw.salePrice ??
    raw.price?.min  ?? raw.price?.regular ??
    (typeof raw.price === 'number' ? raw.price : null);
  const price = priceNum ? `$${Number(priceNum).toLocaleString()}` : null;

  // Images — many possible shapes
  const imgSrc =
    raw.primaryImage?.url ?? raw.primaryImage?.src ??
    raw.images?.[0]?.url ?? raw.images?.[0]?.src ??
    raw.image?.url ?? raw.image?.src ??
    (typeof raw.image === 'string' ? raw.image : null) ??
    raw.imageUrl ?? raw.img ?? null;

  const ensureHttps = u => (u && !u.startsWith('http') ? 'https:' + u : u);
  const imageUrls = [imgSrc].filter(Boolean).map(ensureHttps);

  const slug = raw.slug ?? raw.handle ?? raw.url ?? slugify(name);
  const productUrl = slug.startsWith('http') ? slug
    : slug.startsWith('/') ? BASE + slug
    : `${BASE}/s/${slug}`;

  const sku = raw.sku ?? raw.id ?? raw.productId ?? null;

  return { name, price, priceNum, imageUrls, productUrl, sku, _raw: raw };
}

// ── Scrape a listing page; returns array of stub products ────────────────────

async function scrapeListingPage(page, catPath) {
  const listUrl = BASE + catPath;
  await log(`    GET ${listUrl}`);

  const captured = [];

  // Set up response interception BEFORE navigating
  const onResponse = async response => {
    const url = response.url();
    const ct  = response.headers()['content-type'] || '';
    if (!ct.includes('json') && !ct.includes('javascript')) return;
    // Likely candidate endpoints
    if (
      url.includes('/search') || url.includes('/products') || url.includes('/catalog') ||
      url.includes('/api/') || url.includes('brx.') || url.includes('bloomreach') ||
      url.includes('getproduct') || url.includes('/collection') ||
      (url.includes('cb2') && ct.includes('json'))
    ) {
      try {
        const body = await response.json();
        const items = findProductsInPayload(body);
        if (items && items.length > 0 && !captured.length) {
          await log(`    API hit: ${url.split('?')[0]} — ${items.length} items`);
          captured.push(...items);
        }
      } catch {}
    }
  };

  page.on('response', onResponse);

  try {
    await page.goto(listUrl, { waitUntil: 'networkidle2', timeout: 45000 });
  } catch(err) {
    await log(`    Navigation warning: ${err.message.slice(0,80)}`);
  }

  // Wait a bit more for lazy-loaded JS API calls
  await delay(2500);

  // Scroll to trigger lazy product loading
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => window.scrollBy(0, 600));
    await delay(300);
  }
  await delay(1500);

  page.off('response', onResponse);

  if (captured.length > 0) {
    await log(`    ${captured.length} products from API`);
    return captured.map(normaliseApiProduct).filter(Boolean);
  }

  // ── DOM fallback: extract from rendered page ──────────────────────────────

  await log(`    No API hit — falling back to DOM extraction`);

  const domProducts = await page.evaluate((base) => {
    const results = [];

    // Try JSON-LD ItemList or Product on the page
    for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const d = JSON.parse(el.textContent);
        const walk = obj => {
          if (!obj || typeof obj !== 'object') return;
          if (obj['@type'] === 'Product') {
            results.push({
              name: obj.name,
              price: obj.offers?.price ? `$${obj.offers.price}` : null,
              imageUrls: [(Array.isArray(obj.image) ? obj.image[0] : obj.image)].filter(Boolean),
              productUrl: obj.url || '',
              sku: obj.sku || null,
            });
          }
          if (obj['@type'] === 'ItemList') {
            (obj.itemListElement || []).forEach(el => walk(el.item || el));
          }
          if (Array.isArray(obj)) obj.forEach(walk);
          else Object.values(obj).forEach(v => { if (typeof v === 'object') walk(v); });
        };
        walk(d);
      } catch {}
    }
    if (results.length >= 3) return results;

    // Heuristic: find product cards by common selectors
    const cardSels = [
      '[class*="product-tile"]', '[class*="ProductTile"]', '[class*="product-card"]',
      '[class*="ProductCard"]', '[data-component="ProductTile"]', '[class*="plp-product"]',
    ];
    let cards = [];
    for (const sel of cardSels) {
      const found = document.querySelectorAll(sel);
      if (found.length > 3) { cards = [...found]; break; }
    }

    for (const card of cards.slice(0, 30)) {
      const link = card.querySelector('a[href]');
      const img  = card.querySelector('img');
      const priceEl = card.querySelector('[class*="price"],[class*="Price"]');
      const titleEl = card.querySelector('h2,h3,[class*="title"],[class*="Title"],[class*="name"],[class*="Name"]');
      if (!link) continue;
      const href = link.href;
      const name = titleEl?.textContent?.trim() || img?.alt?.trim() || '';
      if (!name) continue;
      const price = priceEl?.textContent?.trim() || null;
      const imgSrc = img?.src || img?.dataset?.src || null;
      results.push({
        name,
        price: price ? (price.startsWith('$') ? price : null) : null,
        imageUrls: imgSrc ? [imgSrc] : [],
        productUrl: href.startsWith('http') ? href : base + href,
        sku: null,
      });
    }

    return results;
  }, BASE);

  await log(`    DOM fallback: ${domProducts.length} products`);
  return domProducts;
}

// ── Scrape a product detail page for extra info ───────────────────────────────

async function scrapeProductPage(page, productUrl) {
  try {
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await delay(1000);
  } catch {}

  return page.evaluate(() => {
    // JSON-LD Product
    for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const d = JSON.parse(el.textContent);
        const items = Array.isArray(d) ? d : [d];
        for (const item of items) {
          if (item['@type'] === 'Product') {
            const wIn = item.width?.value  || null;
            const dIn = item.depth?.value  || null;
            const hIn = item.height?.value || null;
            const price = item.offers?.price ?? item.offers?.lowPrice ?? null;
            const imgs = [
              ...(Array.isArray(item.image) ? item.image : item.image ? [item.image] : []),
            ].slice(0,4);
            return {
              name:        item.name,
              price:       price ? `$${parseFloat(price).toLocaleString()}` : null,
              priceRaw:    price,
              widthIn:     wIn ? parseFloat(wIn) : null,
              depthIn:     dIn ? parseFloat(dIn) : null,
              heightIn:    hIn ? parseFloat(hIn) : null,
              color:       item.color || null,
              material:    item.material || null,
              description: item.description || null,
              imageUrls:   imgs,
              sku:         item.sku || null,
            };
          }
        }
      } catch {}
    }

    // og:image fallback for images
    const ogImage = document.querySelector('meta[property="og:image"]')?.content;

    // Price from page text
    const priceEl = document.querySelector('[class*="price"],[class*="Price"],[itemprop="price"]');
    const price   = priceEl?.textContent?.trim() || null;

    // Description from og or itemprop
    const desc =
      document.querySelector('meta[name="description"]')?.content ||
      document.querySelector('[itemprop="description"]')?.textContent?.trim() ||
      null;

    // Gallery images
    const imgs = [...document.querySelectorAll('[class*="gallery"] img, [class*="Gallery"] img, [class*="product-image"] img')]
      .map(i => i.src || i.dataset.src).filter(Boolean).slice(0, 4);
    if (ogImage && !imgs.includes(ogImage)) imgs.unshift(ogImage);

    return {
      name:      document.querySelector('h1')?.textContent?.trim() || null,
      price:     price && price.includes('$') ? price.split('\n')[0].trim() : null,
      widthIn:   null, depthIn: null, heightIn: null,
      color:     null, material: null,
      description: desc?.slice(0, 500) || null,
      imageUrls: [...new Set(imgs)].slice(0, 4),
      sku:       null,
    };
  });
}

// ── Infer style from text ─────────────────────────────────────────────────────

function detectStyle(text) {
  const t = (text||'').toLowerCase();
  return /mid-century|mid century|1950|1960|1970|vintage|retro/.test(t) ? 'mid-century'
       : /scandinavian|nordic|danish/.test(t) ? 'scandinavian'
       : /industrial|loft/.test(t) ? 'industrial'
       : /traditional|classic|antique/.test(t) ? 'traditional'
       : /modern|contemporary|minimalist/.test(t) ? 'modern' : 'other';
}

function inToMetres(inches) {
  if (!inches) return null;
  return Math.round(inches / 39.3701 * 100) / 100;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  await log('=== CB2 catalogue builder ===');

  let existing = [];
  if (RESUME && existsSync(OUT_PATH)) {
    existing = JSON.parse(await readFile(OUT_PATH,'utf8')).products || [];
    await log(`Resuming — ${existing.length} existing products`);
  }
  const seenSlugs = new Set(existing.map(p => p.id));

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.setUserAgent(UA);
  // Extra headers to appear more browser-like
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  });

  const products = [...existing];
  let newCount = 0;

  try {
    for (const catInfo of CATEGORIES) {
      await log(`\n── ${catInfo.room.toUpperCase()} / ${catInfo.cat} ──────────────`);
      let stubs = [];

      for (const catPath of catInfo.paths) {
        if (stubs.length >= MAX_PER_CAT) break;
        try {
          const batch = await scrapeListingPage(page, catPath);
          stubs.push(...batch);
        } catch(err) {
          await log(`  ✗ Listing ${catPath}: ${err.message.slice(0,80)}`);
        }
        await delay(1000);
      }

      // De-duplicate stubs by name
      const seen = new Set();
      stubs = stubs.filter(p => {
        const key = slugify(p.name);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      await log(`  ${stubs.length} unique stubs — will detail up to ${MAX_PER_CAT}`);

      let catCount = 0;
      for (const stub of stubs) {
        if (catCount >= MAX_PER_CAT) break;
        const id = slugify(stub.name || stub.sku || 'unknown');
        if (seenSlugs.has(id)) { await log(`  → skip: ${stub.name}`); continue; }

        await log(`  Detailing: ${stub.name}`);
        await delay(600);

        let detail = {};
        if (stub.productUrl && stub.productUrl.startsWith('http')) {
          try { detail = await scrapeProductPage(page, stub.productUrl) || {}; }
          catch(err) { await log(`    detail fail: ${err.message.slice(0,60)}`); }
        }

        // Merge stub + detail (detail wins for richer fields)
        const name      = detail.name || stub.name;
        const price     = detail.price || stub.price;
        const priceRaw  = detail.priceRaw ?? stub.priceNum ?? null;
        const imageUrls = (detail.imageUrls?.length ? detail.imageUrls : stub.imageUrls || []).slice(0,4);
        const productUrl = stub.productUrl || '';
        const widthIn    = detail.widthIn ?? null;
        const depthIn    = detail.depthIn ?? null;
        const heightIn   = detail.heightIn ?? null;
        const description = detail.description || null;
        const colors     = detail.color ? detail.color.split(/,\s*/).map(c=>c.trim()).filter(Boolean) : [];
        const materials  = detail.material ? detail.material.split(/,\s*/).map(m=>m.trim()).filter(Boolean) : [];

        const hay = (name + ' ' + (description||'')).toLowerCase();
        const style = detectStyle(hay);

        const product = {
          id,
          name,
          price,
          priceRaw,
          category: catInfo.cat,
          room:     catInfo.room,
          style,
          colors,
          materials,
          dimensions: widthIn ? {
            widthIn, depthIn, heightIn,
            width:  inToMetres(widthIn),
            depth:  inToMetres(depthIn),
            height: inToMetres(heightIn),
            unit: 'm',
          } : null,
          imageUrls,
          productUrl,
          source: 'cb2',
          description,
          sku: detail.sku || stub.sku || null,
          scrapedAt: new Date().toISOString(),
        };

        products.push(product);
        seenSlugs.add(id);
        newCount++;
        catCount++;

        const dimsStr = widthIn ? `${widthIn}"W × ${depthIn}"D × ${heightIn}"H` : 'dims n/a';
        await log(`  ✓ ${name} | ${price||'—'} | ${dimsStr} | ${imageUrls.length} imgs`);

        // Checkpoint write
        await writeFile(OUT_PATH, JSON.stringify({
          version: '1.0', source: 'cb2',
          builtAt: new Date().toISOString(), total: products.length, products,
        }, null, 2));
      }
    }
  } finally {
    await browser.close();
  }

  await log(`\n=== Done — ${newCount} new, ${products.length} total ===`);

  const byRoom = {};
  products.forEach(p => { (byRoom[p.room]??={})[p.category]=((byRoom[p.room]??={})[p.category]||0)+1; });
  console.log('\nSummary:');
  for (const [r,cats] of Object.entries(byRoom)) {
    console.log(` ${r}:`);
    for (const [c,n] of Object.entries(cats)) console.log(`   ${c}: ${n}`);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
