#!/usr/bin/env node
/**
 * Povison catalogue builder
 * Strategy:
 *   1. Navigate each category listing page (server-side rendered Vue/Nuxt).
 *   2. Collect product links from <a class="product-card"> elements.
 *   3. For each product page: extract JSON-LD (name, price, sku, main image),
 *      og:image, gallery images from ImageKit lazy-loads, description from
 *      og:description, and dimension text from the spec section.
 * Usage:  node buildPovisonCatalogue.mjs
 *         node buildPovisonCatalogue.mjs --resume
 * Output: ../povison-catalogue.json
 */

import puppeteer from 'puppeteer';
import { writeFile, readFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH  = path.join(__dirname, '..', 'povison-catalogue.json');
const LOG_PATH  = path.join(__dirname, '..', 'scrapers', 'povison-scrape.log');
const RESUME    = process.argv.includes('--resume');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE      = 'https://www.povison.com';
const MAX_PER_CAT = 20;
const delay = ms => new Promise(r => setTimeout(r, ms + Math.random() * 200));

// ── Categories ────────────────────────────────────────────────────────────────

const CATEGORIES = [
  { room: 'living room', cat: 'sofa',         urls: ['/sofa/sofas-loveseats.html', '/sofa/sectionals.html'] },
  { room: 'living room', cat: 'armchair',     urls: ['/furniture/chairs/accent-chairs.html'] },
  { room: 'living room', cat: 'coffee table', urls: ['/furniture/living-room-furniture/coffee-tables.html'] },
  { room: 'living room', cat: 'side table',   urls: ['/furniture/living-room-furniture/end-side-tables.html'] },
  { room: 'living room', cat: 'tv unit',      urls: ['/furniture/living-room-furniture/tv-stands.html'] },
  { room: 'living room', cat: 'shelving',     urls: ['/furniture/storage/'] },
  { room: 'bedroom',     cat: 'bed',          urls: ['/furniture/bedroom-furniture/beds.html'] },
  { room: 'bedroom',     cat: 'nightstand',   urls: ['/furniture/bedroom-furniture/nightstands.html'] },
  { room: 'bedroom',     cat: 'dresser',      urls: ['/furniture/bedroom-furniture/dressers-chests.html'] },
  { room: 'bedroom',     cat: 'bench',        urls: ['/furniture/bedroom-furniture/bedroom-benches.html'] },
  { room: 'dining room', cat: 'dining table', urls: ['/furniture/kitchen-dining/dining-tables.html'] },
  { room: 'dining room', cat: 'dining chair', urls: ['/furniture/kitchen-dining/dining-chairs.html'] },
  { room: 'dining room', cat: 'sideboard',    urls: ['/furniture/living-room-furniture/storage-cabinets.html'] },
  { room: 'dining room', cat: 'barstool',     urls: ['/furniture/kitchen-dining/bar-stools.html'] },
  { room: 'other',       cat: 'desk',         urls: ['/furniture/home-office/desks.html', '/furniture/home-office.html'] },
  { room: 'living room', cat: 'rug',          urls: ['/home-decor/rugs/'] },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(t) { return (t||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,''); }
function inToMetres(n) { return n ? Math.round(n * 0.0254 * 100) / 100 : null; }

async function log(msg) {
  console.log(msg);
  await appendFile(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`).catch(()=>{});
}

// Convert ImageKit thumbnail URL to a full-size version
function fullSizeImageKit(url) {
  return url.replace(/\/tr:[^/]+\//, '/tr:w-800,h-800,c-at_max,f-auto/');
}

// ── Collect product links from a listing page ─────────────────────────────────

async function getProductLinks(page, url) {
  await log(`  Loading: ${url}`);
  try {
    await page.goto(BASE + url, { waitUntil: 'networkidle2', timeout: 35000 });
  } catch (err) {
    await log(`    Nav warning: ${err.message.slice(0, 60)}`);
  }
  await delay(1500);

  // Scroll to trigger lazy loading
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.scrollBy(0, 600));
    await delay(300);
  }
  await delay(1000);

  const items = await page.evaluate((base) => {
    const cards = [...document.querySelectorAll('a.product-card, [class*="product-card"][href], [class*="product-item"] a[href]')];
    return cards.map(a => {
      const img = a.querySelector('img');
      const nameEl = a.querySelector('[class*="name"],[class*="title"],[class*="product-name"]');
      const priceEl = a.querySelector('[class*="price"],[class*="Price"]');
      const href = a.href || a.getAttribute('href');
      const slug = href?.split('/').pop()?.replace(/\.html.*/, '') || '';
      return {
        href: href?.startsWith('http') ? href : (base + href),
        slug,
        name: nameEl?.textContent?.trim()?.replace(/\s+/g,' ') || img?.alt || '',
        imgSrc: img?.src || img?.dataset?.src || null,
        price: priceEl?.textContent?.trim()?.match(/\$[\d,]+(?:\.\d{2})?/)?.[0] || null,
      };
    }).filter(i => i.slug && i.href);
  }, BASE);

  await log(`  Found ${items.length} product links`);
  return items;
}

// ── Scrape a product detail page ──────────────────────────────────────────────

async function scrapeProduct(page, href) {
  try {
    await page.goto(href, { waitUntil: 'networkidle2', timeout: 30000 });
  } catch (err) {
    await log(`    Nav warning: ${err.message.slice(0, 60)}`);
  }
  await delay(800);

  return page.evaluate(() => {
    // JSON-LD Product
    let ld = null;
    for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const d = JSON.parse(el.textContent);
        if (d['@type'] === 'Product') { ld = d; break; }
      } catch {}
    }

    // Name
    const name = ld?.name || document.querySelector('h1')?.textContent?.trim() || null;

    // Price
    const priceRaw = ld?.offers?.price ? parseFloat(ld.offers.price) : null;
    const price = priceRaw ? `$${priceRaw.toLocaleString()}` : null;

    // Images
    // 1. JSON-LD main image
    const ldImg = Array.isArray(ld?.image) ? ld.image[0] : (ld?.image || null);
    // 2. og:image
    const ogImg = document.querySelector('meta[property="og:image"]')?.content || null;
    // 3. Gallery from ImageKit lazy-loaded thumbnails → enlarge
    const ikImgs = [...document.querySelectorAll('img[data-src*="imagekit"], img[src*="imagekit"]')]
      .map(i => (i.dataset.src || i.src).replace(/\/tr:[^/]+\//, '/tr:w-800,h-800,c-at_max,f-auto/'))
      .filter(s => s.includes('catalog/product'))
      .slice(0, 5);

    // Also try static.povison.com images
    const staticImgs = [...document.querySelectorAll('img[src*="static.povison.com/media/catalog"]')]
      .map(i => i.src).slice(0, 4);

    const allImgs = [ldImg, ogImg, ...ikImgs, ...staticImgs].filter(Boolean);
    const uniqueImgs = [...new Set(allImgs)].slice(0, 4);

    // Description — og:description is often cleaner
    const desc = document.querySelector('meta[name="description"]')?.content
      || document.querySelector('meta[property="og:description"]')?.content
      || ld?.description
      || null;

    // Dimensions — search only in spec section to avoid matching related product cards
    const bodyText = document.body.innerText;
    let widthIn = null, depthIn = null, heightIn = null;

    // Look for a dedicated spec container, fall back to product-info area only
    const specEl = document.querySelector('[class*="spec"],[class*="param"],[class*="detail-info"],[class*="product-info"]');
    // Take only the first 2000 chars of the spec text to avoid related product sections
    const specText = specEl ? specEl.innerText.slice(0, 2000) : bodyText.slice(0, 2000);

    const dimPatterns = [
      /(\d+(?:\.\d+)?)["\s]*W\s*[×xX]\s*(\d+(?:\.\d+)?)["\s]*D\s*[×xX]\s*(\d+(?:\.\d+)?)["\s]*H/i,
      /Overall[^:]*:\s*(\d+(?:\.\d+)?)"\s*[×xX]\s*(\d+(?:\.\d+)?)"\s*[×xX]\s*(\d+(?:\.\d+?)?)"/i,
      /Width[^:\d]*(\d+(?:\.\d+)?)["'].*?Depth[^:\d]*(\d+(?:\.\d+)?)["'].*?Height[^:\d]*(\d+(?:\.\d+)?)["']/is,
    ];
    for (const pat of dimPatterns) {
      const m = specText.match(pat);
      if (m) { widthIn = parseFloat(m[1]); depthIn = parseFloat(m[2]); heightIn = parseFloat(m[3]); break; }
    }

    // Colors
    const colorEls = [...document.querySelectorAll('[class*="color-item"],[class*="swatch"],[class*="variant-item"]')]
      .map(el => el.getAttribute('title') || el.textContent.trim()).filter(Boolean).slice(0, 8);

    // Materials from spec
    const matMatch = specText.match(/Material[:\s]+([^\n]{3,40})/i);
    const materials = matMatch ? [matMatch[1].trim()] : [];

    return {
      name,
      price,
      priceRaw,
      imageUrls: uniqueImgs,
      description: desc?.replace(/\s+/g, ' ').trim().slice(0, 500) || null,
      widthIn, depthIn, heightIn,
      colors: colorEls,
      materials,
      sku: ld?.sku || null,
    };
  });
}

// ── Style detection ───────────────────────────────────────────────────────────

function detectStyle(text) {
  const t = (text || '').toLowerCase();
  return /mid-century|mid century|retro/.test(t) ? 'mid-century'
       : /scandinavian|nordic/.test(t) ? 'scandinavian'
       : /industrial/.test(t) ? 'industrial'
       : /traditional|classic/.test(t) ? 'traditional'
       : /modern|contemporary|minimalist/.test(t) ? 'modern' : 'other';
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  await log('=== Povison catalogue builder ===');

  let existing = [];
  if (RESUME && existsSync(OUT_PATH)) {
    existing = JSON.parse(await readFile(OUT_PATH, 'utf8')).products || [];
    await log(`Resuming — ${existing.length} existing products`);
  }
  const seenSlugs = new Set(existing.map(p => p.slug));

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  let page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.setUserAgent(UA);

  async function resetPage() {
    try { await page.close(); } catch {}
    page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent(UA);
  }

  const products = [...existing];
  let newCount = 0, errorCount = 0;

  try {
    for (const catInfo of CATEGORIES) {
      await log(`\n── ${catInfo.room.toUpperCase()} / ${catInfo.cat} ──────────────`);
      let stubs = [];

      for (const url of catInfo.urls) {
        if (stubs.length >= MAX_PER_CAT * 3) break; // enough candidates
        try {
          const batch = await getProductLinks(page, url);
          stubs.push(...batch);
        } catch (err) {
          await log(`  ✗ Listing ${url}: ${err.message.slice(0, 60)}`);
          if (/detached/i.test(err.message)) await resetPage();
        }
        await delay(600);
      }

      // De-duplicate by slug
      const seen = new Set();
      stubs = stubs.filter(s => {
        if (!s.slug || seen.has(s.slug)) return false;
        seen.add(s.slug);
        return true;
      });
      await log(`  ${stubs.length} unique stubs`);

      let catCount = 0;
      for (const stub of stubs) {
        if (catCount >= MAX_PER_CAT) break;
        if (seenSlugs.has(stub.slug)) { await log(`  → skip: ${stub.slug}`); continue; }

        await log(`  Detailing: ${stub.name || stub.slug}`);
        await delay(500);

        let detail = {};
        try {
          detail = await scrapeProduct(page, stub.href) || {};
        } catch (err) {
          await log(`    Detail fail: ${err.message.slice(0, 60)}`);
          if (/detached/i.test(err.message)) await resetPage();
          errorCount++;
        }

        const name      = detail.name || stub.name;
        const price     = detail.price || stub.price;
        const imageUrls = (detail.imageUrls?.length ? detail.imageUrls : [stub.imgSrc].filter(Boolean)).slice(0, 4);
        const widthIn   = detail.widthIn ?? null;
        const depthIn   = detail.depthIn ?? null;
        const heightIn  = detail.heightIn ?? null;
        const hay = (name + ' ' + (detail.description || '')).toLowerCase();

        const product = {
          id:       slugify(name || stub.slug),
          slug:     stub.slug,
          name,
          price,
          priceRaw: detail.priceRaw ?? null,
          category: catInfo.cat,
          room:     catInfo.room,
          style:    detectStyle(hay),
          colors:   detail.colors || [],
          materials: detail.materials || [],
          dimensions: widthIn ? {
            widthIn, depthIn, heightIn,
            width:  inToMetres(widthIn),
            depth:  inToMetres(depthIn),
            height: inToMetres(heightIn),
            unit: 'm',
          } : null,
          imageUrls,
          productUrl: stub.href,
          source: 'povison',
          description: detail.description || null,
          sku: detail.sku || null,
          scrapedAt: new Date().toISOString(),
        };

        products.push(product);
        seenSlugs.add(stub.slug);
        newCount++;
        catCount++;

        const dimsStr = widthIn ? `${widthIn}"W × ${depthIn}"D × ${heightIn}"H` : 'dims n/a';
        await log(`  ✓ ${name} | ${price || '—'} | ${dimsStr} | ${imageUrls.length} imgs`);

        await writeFile(OUT_PATH, JSON.stringify({
          version: '1.0', source: 'povison',
          builtAt: new Date().toISOString(), total: products.length, products,
        }, null, 2));
      }
    }
  } finally {
    await browser.close();
  }

  await log(`\n=== Done — ${newCount} new, ${errorCount} errors, ${products.length} total ===`);

  const byRoom = {};
  products.forEach(p => { (byRoom[p.room] ??= {})[p.category] = ((byRoom[p.room] ??= {})[p.category] || 0) + 1; });
  console.log('\nSummary:');
  for (const [r, cats] of Object.entries(byRoom)) {
    console.log(` ${r}:`);
    for (const [c, n] of Object.entries(cats)) console.log(`   ${c}: ${n}`);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
