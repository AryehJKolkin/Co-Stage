#!/usr/bin/env node
/**
 * West Elm catalogue scraper
 *
 * Strategy:
 *   1. Load each category page in a real browser session
 *   2. Scroll fully to trigger lazy-loaded products — capture product slugs
 *      from the /promotion/eligibility/group/{slug}/ network requests West Elm
 *      fires for every visible product
 *   3. For each slug, call /api/catalog/v1/groups/{slug}/dream-pip.json (in the
 *      same browser session so auth cookies are present) to get dimensions,
 *      images, and description
 *   4. Extract name + price from the page DOM
 *
 * Output: west-elm-catalogue.json  (repo root)
 * Usage:
 *   node scrapers/buildWestElmCatalogue.mjs
 *   node scrapers/buildWestElmCatalogue.mjs --resume
 */

import { writeFile, readFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Must be run from backend/ directory so the native ESM puppeteer import resolves
const { default: puppeteer } = await import('puppeteer');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH  = path.join(__dirname, '..', 'west-elm-catalogue.json');
const LOG_PATH  = path.join(__dirname, 'westelm-scrape.log');
const RESUME    = process.argv.includes('--resume');
const UA        = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const IMG_BASE  = 'https://asset.wsimgs.com/wsimgs/ab/images/';

// ── Categories ───────────────────────────────────────────────────────────────

const CATEGORIES = [
  // Living room
  { room: 'living room', cat: 'sofa',        url: 'https://www.westelm.com/shop/furniture/sofas-sectionals/' },
  { room: 'living room', cat: 'armchair',    url: 'https://www.westelm.com/shop/furniture/chairs-recliners/' },
  { room: 'living room', cat: 'coffee table',url: 'https://www.westelm.com/shop/furniture/coffee-tables/' },
  { room: 'living room', cat: 'side table',  url: 'https://www.westelm.com/shop/furniture/side-tables-end-tables/' },
  { room: 'living room', cat: 'tv unit',     url: 'https://www.westelm.com/shop/furniture/media-consoles-tv-stands/' },
  // Bedroom
  { room: 'bedroom',     cat: 'bed',         url: 'https://www.westelm.com/shop/furniture/beds/' },
  { room: 'bedroom',     cat: 'nightstand',  url: 'https://www.westelm.com/shop/furniture/nightstands/' },
  { room: 'bedroom',     cat: 'dresser',     url: 'https://www.westelm.com/shop/furniture/dressers-armoires/' },
  // Dining room
  { room: 'dining room', cat: 'dining table',url: 'https://www.westelm.com/shop/furniture/dining-tables/' },
  { room: 'dining room', cat: 'dining chair',url: 'https://www.westelm.com/shop/furniture/dining-chairs-benches/' },
  { room: 'dining room', cat: 'sideboard',   url: 'https://www.westelm.com/shop/furniture/buffets-sideboards/' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function slugify(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}
function inchesToMetres(n) { return Math.round(n * 0.0254 * 100) / 100; }

function parseDimsFromHtml(html) {
  // dream-pip content is like "60"w x 39"d x 33"h"
  const clean = html.replace(/&quot;/g, '"').replace(/<[^>]+>/g, ' ');
  const m = clean.match(/(\d+(?:\.\d+)?)["\s]*w\s*x\s*(\d+(?:\.\d+)?)["\s]*d\s*x\s*(\d+(?:\.\d+)?)["\s]*h/i);
  if (!m) return null;
  return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
}

async function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(msg);
  await appendFile(LOG_PATH, line + '\n').catch(() => {});
}
async function delay(ms) { return new Promise(r => setTimeout(r, ms + Math.random() * 300)); }

// ── Slug harvesting ───────────────────────────────────────────────────────────

async function harvestSlugs(page, catInfo) {
  await log(`  Loading: ${catInfo.url}`);

  await page.goto(catInfo.url, { waitUntil: 'networkidle2', timeout: 35000 });

  // Scroll repeatedly to trigger lazy-loaded product cards
  for (let pass = 0; pass < 14; pass++) {
    await page.evaluate(() => window.scrollBy(0, 700));
    await delay(600);
  }
  await delay(2500);

  // Extract slugs from product links and any promo-eligibility URLs embedded in the page
  const slugs = await page.evaluate(() => {
    const found = new Set();
    // Product links: /products/{slug}/
    document.querySelectorAll('a[href*="/products/"]').forEach(a => {
      const m = a.href.match(/\/products\/([a-z0-9][a-z0-9-]+-[a-z0-9]+)\/?/i);
      if (m && !m[1].includes('swatch') && !m[1].includes('gift')) found.add(m[1]);
    });
    // Inline script tags may contain product slugs in JSON
    document.querySelectorAll('script:not([src])').forEach(s => {
      const matches = s.textContent.matchAll(/"([a-z][a-z0-9-]+-[hgf]\d{3,6})"/g);
      for (const m of matches) found.add(m[1]);
    });
    return [...found];
  });

  await log(`  Captured ${slugs.length} product slugs`);
  return slugs;
}

// ── Product data ─────────────────────────────────────────────────────────────

async function fetchProductData(page, slug) {
  // Fetch dream-pip API from within browser context (uses active session cookies)
  const raw = await page.evaluate(async (slug) => {
    try {
      const [pipR, attrsR] = await Promise.all([
        fetch('/api/catalog/v1/groups/' + slug + '/dream-pip.json').then(r => r.json()),
        fetch('/api/catalog/v1/groups/' + slug + '/subsets/0/attributes.json').then(r => r.json()),
      ]);
      return { pip: pipR, attrs: attrsR };
    } catch (e) {
      return { error: e.message };
    }
  }, slug);

  if (raw.error) throw new Error(raw.error);

  const pip   = raw.pip;
  const attrs = raw.attrs;

  // ── Dimensions — use first size variant's overall dimensions ──
  let dimsIn = null;
  for (const dimBlock of (pip.dimensions || [])) {
    const parsed = parseDimsFromHtml(dimBlock.content || '');
    if (parsed) { dimsIn = parsed; break; }
  }

  // ── Images — first lifestyle image, construct full URL ──
  const imgAssetBase = 'https://asset.wsimgs.com/wsimgs/ab/images/';
  const imageUrls = (pip.lifeStyleImages || [])
    .filter(i => i.path)
    .slice(0, 4)
    .map(i => `${imgAssetBase}${i.path}xxxx.jpg`);

  // ── Description from contentBlocks ──
  const rawDesc = pip.contentBlocks?.productBlurb || '';
  const description = rawDesc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500) || null;

  // ── Colors from attribute types ──
  const colorAttr = (attrs.attributeTypes || []).find(a => a.id === 'color' || a.name?.toLowerCase().includes('color') || a.name?.toLowerCase().includes('material'));
  const colors = (colorAttr?.attributeValues || []).map(v => v.name?.replace(/&quot;/g, '"')).filter(Boolean).slice(0, 12);

  // ── Size labels ──
  const sizeAttr = (attrs.attributeTypes || []).find(a => a.id === 'furnitureSize' || a.name?.toLowerCase().includes('size'));
  const sizes = (sizeAttr?.attributeValues || []).map(v => v.name?.replace(/&quot;/g, '"')).filter(Boolean).slice(0, 6);

  return { dimsIn, imageUrls, description, colors, sizes };
}

async function getNameAndPrice(page, slug) {
  // Navigate to the product page to get the name and price from the DOM
  await page.goto(`https://www.westelm.com/products/${slug}/`, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await delay(1500);

  return await page.evaluate(() => {
    // Name from h1 or page title
    const h1 = document.querySelector('h1');
    const name = h1?.textContent?.trim() || document.title.replace(/\s*[\|–-].*$/, '').trim();

    // Price — look for price elements
    const priceEl = document.querySelector('[class*=price],[data-price],[itemprop=price]');
    let price = priceEl?.textContent?.trim()?.match(/\$[\d,]+(?:\.\d{2})?/)?.[0];

    // Fallback: look for $ in body text near "Starting at" or first $ occurrence
    if (!price) {
      const m = document.body.innerText.match(/\$[\d,]+(?:\.\d{2})?/);
      if (m) price = m[0];
    }

    // Description fallback from meta
    const metaDesc = document.querySelector('meta[name=description]')?.content?.trim();

    return { name, price, metaDesc };
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  await log('=== West Elm catalogue scraper starting ===');

  let existing = [];
  if (RESUME && existsSync(OUT_PATH)) {
    existing = JSON.parse(await readFile(OUT_PATH, 'utf8')).products || [];
    await log(`Resuming — ${existing.length} products already saved`);
  }
  const seenSlugs = new Set(existing.map(p => p.slug));

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });

  // Two pages: one for category browsing / API calls, one for product detail
  const catPage  = await browser.newPage();
  const prodPage = await browser.newPage();
  await catPage.setUserAgent(UA);
  await prodPage.setUserAgent(UA);

  // Warm up a session so cookies are set
  await catPage.goto('https://www.westelm.com/', { waitUntil: 'networkidle2', timeout: 25000 });
  await delay(1000);

  const products = [...existing];
  let newCount = 0, errorCount = 0;

  try {
    for (const catInfo of CATEGORIES) {
      await log(`\n── ${catInfo.room.toUpperCase()} / ${catInfo.cat} ──────────────`);

      let slugs;
      try {
        slugs = await harvestSlugs(catPage, catInfo);
      } catch (err) {
        await log(`  ✗ Category page failed: ${err.message}`);
        errorCount++;
        continue;
      }

      for (const slug of slugs) {
        if (seenSlugs.has(slug)) { await log(`  → skip: ${slug}`); continue; }

        await log(`  Scraping: ${slug}`);
        await delay(1200);

        try {
          // Fetch API data from the category page context (session already active)
          const pipData = await fetchProductData(catPage, slug);

          // Get name + price from product page
          const { name, price, metaDesc } = await getNameAndPrice(prodPage, slug);
          const finalDesc = pipData.description || metaDesc || null;

          const [wIn, dIn, hIn] = pipData.dimsIn || [null, null, null];
          const guessCategory = catInfo.cat;
          const haystack = (name + ' ' + (finalDesc || '')).toLowerCase();
          const style = haystack.includes('mid-century') || haystack.includes('mid century') ? 'mid-century'
                      : haystack.includes('modern') || haystack.includes('contemporary')    ? 'modern'
                      : haystack.includes('scandinavian') ? 'scandinavian'
                      : haystack.includes('industrial')   ? 'industrial'
                      : haystack.includes('traditional')  ? 'traditional'
                      : 'other';

          const product = {
            id:          slugify(name || slug),
            slug,
            name:        name || slug,
            price,
            category:    guessCategory,
            room:        catInfo.room,
            style,
            colors:      pipData.colors,
            sizes:       pipData.sizes,
            dimensions:  wIn ? {
              widthIn: wIn, depthIn: dIn, heightIn: hIn,
              width: inchesToMetres(wIn), depth: inchesToMetres(dIn), height: inchesToMetres(hIn),
              unit: 'm',
            } : null,
            imageUrls:   pipData.imageUrls,
            productUrl:  `https://www.westelm.com/products/${slug}/`,
            source:      'west-elm',
            description: finalDesc,
            scrapedAt:   new Date().toISOString(),
          };

          products.push(product);
          seenSlugs.add(slug);
          newCount++;

          const dimsLabel = wIn ? `${wIn}"W × ${dIn}"D × ${hIn}"H` : 'dims n/a';
          await log(`  ✓ ${product.name} | ${product.price || 'price n/a'} | ${dimsLabel} | ${product.imageUrls.length} img(s)`);

          await writeFile(OUT_PATH, JSON.stringify({
            version: '1.0', source: 'west-elm',
            builtAt: new Date().toISOString(), total: products.length, products,
          }, null, 2));

        } catch (err) {
          await log(`  ✗ Failed: ${slug} — ${err.message}`);
          errorCount++;
        }
      }
    }
  } finally {
    await browser.close();
  }

  await log(`\n=== Done — ${newCount} new, ${errorCount} errors. Total: ${products.length} ===`);

  const byRoom = {};
  for (const p of products) {
    if (!byRoom[p.room]) byRoom[p.room] = {};
    if (!byRoom[p.room][p.category]) byRoom[p.room][p.category] = 0;
    byRoom[p.room][p.category]++;
  }
  console.log('\nCatalogue summary:');
  for (const [room, cats] of Object.entries(byRoom)) {
    console.log(`  ${room}:`);
    for (const [cat, count] of Object.entries(cats)) console.log(`    ${cat}: ${count} items`);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
