#!/usr/bin/env node
/**
 * Soho Home catalogue scraper — run from backend/ directory
 * Strategy:
 *   1. Load each category listing page and extract product URLs via a.product__link
 *   2. Classify products into target categories using name/slug keywords
 *   3. For each product, visit its page and parse JSON-LD schema.org Product data
 *      (price, width/depth/height in cm, color, material, image, description)
 * Usage:  node buildSohoHomeCatalogue.mjs
 *         node buildSohoHomeCatalogue.mjs --resume
 * Output: ../soho-home-catalogue.json
 */

import puppeteer from 'puppeteer';
import { writeFile, readFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH  = path.join(__dirname, '..', 'soho-home-catalogue.json');
const LOG_PATH  = path.join(__dirname, '..', 'scrapers', 'sohohome-scrape.log');
const RESUME    = process.argv.includes('--resume');
const UA        = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE      = 'https://www.sohohome.com';
const MAX_PER_CAT = 20;

// ── Category listing pages ────────────────────────────────────────────────────

const LISTING_PAGES = [
  { url: '/us/furniture/sofas',                              hint: 'living room' },
  { url: '/us/furniture/armchairs',                          hint: 'living room' },
  { url: '/us/furniture/coffee-tables-side-tables',          hint: 'living room' },
  { url: '/us/furniture/sideboards-and-media-units',         hint: 'mixed' },
  { url: '/us/furniture/beds-and-mattresses',                hint: 'bedroom' },
  { url: '/us/furniture/bedside-tables-and-chest-of-drawers',hint: 'bedroom' },
  { url: '/us/furniture/dining-tables-and-chairs',           hint: 'dining room' },
  // New categories
  { url: '/us/furniture/bar-cabinets-and-barstools',         hint: 'dining room' },
  { url: '/us/furniture/footstools',                         hint: 'bedroom' },
  { url: '/us/furniture/desks',                              hint: 'other' },
  { url: '/us/furniture/entryway-consoles-and-shelving',     hint: 'living room' },
  { url: '/us/textiles/rugs',                               hint: 'living room' },
];

// ── Product classification ────────────────────────────────────────────────────

function classify(name, slug, eeCategory) {
  const n = (name + ' ' + slug).toLowerCase();
  const c = (eeCategory||'').toLowerCase();

  if (/mattress|bed-base/.test(n)) return null; // skip mattresses
  if (/bar cabinet|bar trolley|wine rack/.test(n)) return null; // skip bar cabinets
  if (/\brug\b|area rug/.test(n)) return { room: 'living room', cat: 'rug' };

  // New categories
  if (/bar stool|barstool|counter stool/.test(n)) return { room: 'dining room', cat: 'barstool' };
  if (/ottoman|footstool|pouffe|pouf/.test(n)) return null; // skip ottomans/poufs, only keep benches
  if (/bench/.test(n)) return { room: 'bedroom', cat: 'bench' };
  if (/desk/.test(n)) return { room: 'other', cat: 'desk' };
  if (/bookcase|bookshelf|shelving|shelf|shelves|etagere|console/.test(n) && !/side table|end table/.test(n)) return { room: 'living room', cat: 'shelving' };

  // Dining
  if (/dining chair|dining bench|dining stool/.test(n)) return { room: 'dining room', cat: 'dining chair' };
  if (/dining table|dining desk/.test(n)) return { room: 'dining room', cat: 'dining table' };
  if (/dining/.test(c) && /chair|bench|stool/.test(n)) return { room: 'dining room', cat: 'dining chair' };
  if (/dining/.test(c) && /table/.test(n)) return { room: 'dining room', cat: 'dining table' };

  // Sideboards & media
  if (/media console|media unit|tv cabinet|tv unit/.test(n)) return { room: 'living room', cat: 'tv unit' };
  if (/sideboard|buffet/.test(n)) return { room: 'dining room', cat: 'sideboard' };

  // Bedroom
  if (/bedside table|nightstand/.test(n)) return { room: 'bedroom', cat: 'nightstand' };
  if (/chest of drawer|dresser|wardrobe|armoire/.test(n)) return { room: 'bedroom', cat: 'dresser' };
  if (/ bed[^s]| bed$/.test(n) || /beds/.test(c)) return { room: 'bedroom', cat: 'bed' };

  // Living room furniture
  if (/coffee table/.test(n)) return { room: 'living room', cat: 'coffee table' };
  if (/side table|end table|accent table|drinks table|lamp table/.test(n)) return { room: 'living room', cat: 'side table' };
  if (/sofa|sectional|settee|loveseat/.test(n)) return { room: 'living room', cat: 'sofa' };
  if (/armchair|accent chair|lounge chair|swivel chair|tub chair|wing chair|club chair/.test(n)) return { room: 'living room', cat: 'armchair' };
  if (/chair/.test(n)) return { room: 'living room', cat: 'armchair' };
  if (/table/.test(n)) return { room: 'living room', cat: 'coffee table' };

  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(t) { return (t||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,''); }
function cmToMetres(cm) { return Math.round(cm / 100 * 100) / 100; }
function cmToInches(cm) { return Math.round(cm / 2.54 * 10) / 10; }

async function log(msg) {
  console.log(msg);
  await appendFile(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`).catch(()=>{});
}
const delay = ms => new Promise(r => setTimeout(r, ms + Math.random()*200));

// ── Category listing: extract product URLs ────────────────────────────────────

async function getProductSlugs(page, listingUrl) {
  await log(`  Loading: ${listingUrl}`);
  await page.goto(BASE + listingUrl, { waitUntil: 'networkidle2', timeout: 40000 });
  await delay(1000);

  for (let i = 0; i < 14; i++) {
    await page.evaluate(() => window.scrollBy(0, 700));
    await delay(400);
  }
  await delay(1500);

  const items = await page.evaluate(() => {
    return [...document.querySelectorAll('a.product__link')].map(a => {
      const article = a.closest('article');
      let ee = {};
      try { ee = JSON.parse(article?.dataset?.ee || '{}'); } catch(e) {}
      return {
        href: a.href,
        name: a.textContent.trim().replace(/\s+/g,' '),
        eeCategory: ee.category || '',
        slug: a.href.split('/products/')[1]?.split('/')[0] || '',
      };
    });
  });

  await log(`  Found ${items.length} product links`);
  return items;
}

// ── Product page: extract JSON-LD ─────────────────────────────────────────────

async function scrapeProduct(page, href) {
  await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await delay(800);

  return page.evaluate(() => {
    // Parse JSON-LD
    const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
    let ld = null;
    for (const s of scripts) {
      try {
        const d = JSON.parse(s.textContent);
        if (d['@type'] === 'Product') { ld = d; break; }
      } catch(e) {}
    }

    // Images: main from JSON-LD + gallery images
    const galleryImgs = [...document.querySelectorAll('.product__gallery img, [class*=gallery] img, [class*=product__image] img')]
      .map(i => i.src || i.dataset.src).filter(s => s && s.includes('sohohome'));
    const mainImg = ld?.image || '';
    const allImgs = [mainImg, ...galleryImgs].filter(Boolean);
    const uniqueImgs = [...new Set(allImgs)].slice(0, 4);

    // Description — look for product description sections
    const descEl = document.querySelector('[class*=product__description],[class*=description],[itemprop=description]');
    const desc = descEl?.textContent?.replace(/\s+/g,' ').trim().slice(0, 500) || '';

    // Price — prefer JSON-LD, fallback to page
    const price = ld?.offers?.price ? `$${parseFloat(ld.offers.price).toLocaleString()}` : null;

    return {
      name: ld?.name || document.querySelector('h1')?.textContent?.trim(),
      price,
      priceRaw: ld?.offers?.price || null,
      currency: ld?.offers?.priceCurrency || 'USD',
      widthCm:  ld?.width?.value || null,
      depthCm:  ld?.depth?.value || null,
      heightCm: ld?.height?.value || null,
      color:    ld?.color || null,
      material: ld?.material || null,
      imageUrls: uniqueImgs,
      description: desc,
      sku: ld?.sku || null,
    };
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  await log('=== Soho Home catalogue scraper ===');

  let existing = [];
  if (RESUME && existsSync(OUT_PATH)) {
    existing = JSON.parse(await readFile(OUT_PATH,'utf8')).products || [];
    await log(`Resuming — ${existing.length} existing products`);
  }
  const seenSlugs = new Set(existing.map(p => p.slug));

  const browser = await puppeteer.launch({ headless:'new', args:['--no-sandbox','--disable-setuid-sandbox'] });

  async function freshPage() {
    const p = await browser.newPage();
    await p.setUserAgent(UA);
    return p;
  }

  const products = [...existing];
  let newCount = 0, errorCount = 0;

  // Track how many we've added per target category
  const catCounts = {};

  try {
    for (const listing of LISTING_PAGES) {
      await log(`\n══ ${listing.url} ══════════════`);

      // Fresh page per listing prevents detached-frame errors from prior navigations
      const listPage = await freshPage();
      let items;
      try { items = await getProductSlugs(listPage, listing.url); }
      catch(err) { await log(`  ✗ Listing failed: ${err.message}`); errorCount++; await listPage.close().catch(()=>{}); continue; }
      await listPage.close().catch(()=>{});

      let page = await freshPage();
      try {
      for (const item of items) {
        if (!item.slug) continue;
        if (seenSlugs.has(item.slug)) { await log(`  → skip: ${item.slug}`); continue; }

        const cat = classify(item.name, item.slug, item.eeCategory);
        if (!cat) { await log(`  ✗ Unclassified: ${item.name}`); continue; }

        const catKey = `${cat.room}|${cat.cat}`;
        catCounts[catKey] = catCounts[catKey] || 0;
        if (catCounts[catKey] >= MAX_PER_CAT) { await log(`  → cap reached: ${catKey}`); continue; }

        await log(`  Scraping [${catKey}]: ${item.slug}`);
        await delay(800);

        try {
          const data = await scrapeProduct(page, item.href);

          const wCm = data.widthCm, dCm = data.depthCm, hCm = data.heightCm;
          const wIn = wCm ? cmToInches(wCm) : null;
          const dIn = dCm ? cmToInches(dCm) : null;
          const hIn = hCm ? cmToInches(hCm) : null;

          const hay = ((data.name||'')+(data.description||'')).toLowerCase();
          const style = /mid-century|mid century/.test(hay) ? 'mid-century'
                      : /scandinavian|nordic/.test(hay)    ? 'scandinavian'
                      : /industrial/.test(hay)             ? 'industrial'
                      : /traditional|classic/.test(hay)    ? 'traditional'
                      : /modern|contemporary|minimalist/.test(hay) ? 'modern' : 'other';

          const colors = data.color ? data.color.split(/,\s*|\s+and\s+/).map(c=>c.trim()).filter(Boolean) : [];
          const materials = data.material ? data.material.split(/,\s*|\s+and\s+/).map(m=>m.trim()).filter(Boolean) : [];

          const product = {
            id:       slugify(data.name || item.slug),
            slug:     item.slug,
            name:     data.name || item.name,
            price:    data.price,
            priceRaw: data.priceRaw,
            category: cat.cat,
            room:     cat.room,
            style,
            colors,
            materials,
            dimensions: wCm ? {
              widthCm: wCm, depthCm: dCm, heightCm: hCm,
              widthIn: wIn, depthIn: dIn, heightIn: hIn,
              width:  cmToMetres(wCm), depth: cmToMetres(dCm), height: cmToMetres(hCm), unit: 'm',
            } : null,
            imageUrls:  data.imageUrls,
            productUrl: item.href,
            source:     'soho-home',
            description: data.description || null,
            sku:        data.sku,
            scrapedAt:  new Date().toISOString(),
          };

          products.push(product);
          seenSlugs.add(item.slug);
          catCounts[catKey]++;
          newCount++;

          const dimsLabel = wCm ? `${wCm}cm W × ${dCm}cm D × ${hCm}cm H` : 'dims n/a';
          await log(`  ✓ ${product.name} | ${product.price||'—'} | ${dimsLabel} | ${product.imageUrls.length} imgs`);

          await writeFile(OUT_PATH, JSON.stringify({
            version: '1.0', source: 'soho-home',
            builtAt: new Date().toISOString(), total: products.length, products,
          }, null, 2));

        } catch(err) {
          await log(`  ✗ ${item.slug}: ${err.message}`);
          errorCount++;
          // Recover from detached frame by recreating the page
          if (/detached/i.test(err.message)) {
            await page.close().catch(()=>{});
            page = await freshPage();
          }
        }
      }
      } finally { await page.close().catch(()=>{}); }
    }
  } finally { await browser.close(); }

  await log(`\n=== Done — ${newCount} new, ${errorCount} errors, ${products.length} total ===`);

  const byRoom = {};
  products.forEach(p => { (byRoom[p.room]??={})[p.category]=((byRoom[p.room]??={})[p.category]||0)+1; });
  console.log('\nSummary:');
  for (const [r,cats] of Object.entries(byRoom)) {
    console.log(` ${r}:`);
    for (const [c,n] of Object.entries(cats)) console.log(`   ${c}: ${n}`);
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
