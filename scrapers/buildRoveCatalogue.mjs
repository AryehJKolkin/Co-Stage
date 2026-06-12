#!/usr/bin/env node
/**
 * Rove Concepts catalogue scraper
 *
 * Scrapes living room, bedroom, and dining room furniture from roveconcepts.com
 * and builds rove-concepts-catalogue.json with full product details:
 *   name, price, dimensions (inches + metres), materials, colors,
 *   category, style, images, product URL
 *
 * Usage:
 *   node scrapers/buildRoveCatalogue.mjs
 *   node scrapers/buildRoveCatalogue.mjs --resume   (skip products already saved)
 *
 * Output: rove-concepts-catalogue.json  (repo root)
 * Logs:   scrapers/rove-scrape.log
 */

import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
const _pup = _require('../backend/node_modules/puppeteer/lib/puppeteer/puppeteer.js');
const puppeteer = _pup.default || _pup;
import { writeFile, readFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH   = path.join(__dirname, '..', 'rove-concepts-catalogue.json');
const LOG_PATH   = path.join(__dirname, 'rove-scrape.log');
const RESUME     = process.argv.includes('--resume');
const DELAY_MS   = 1500;   // polite pause between product page requests

// ── Categories to scrape ─────────────────────────────────────────────────────

const CATEGORIES = [
  // Living room
  { room: 'living room', cat: 'sofa',        url: 'https://www.roveconcepts.com/modern-sofas.html' },
  { room: 'living room', cat: 'sectional',   url: 'https://www.roveconcepts.com/modern-sectional-sofas.html' },
  { room: 'living room', cat: 'armchair',    url: 'https://www.roveconcepts.com/modern-lounge-chairs.html' },
  { room: 'living room', cat: 'coffee table',url: 'https://www.roveconcepts.com/modern-coffee-tables.html' },
  { room: 'living room', cat: 'side table',  url: 'https://www.roveconcepts.com/modern-side-tables.html' },
  { room: 'living room', cat: 'tv unit',     url: 'https://www.roveconcepts.com/modern-tv-stands.html' },
  // Bedroom
  { room: 'bedroom',     cat: 'bed',         url: 'https://www.roveconcepts.com/modern-beds.html' },
  { room: 'bedroom',     cat: 'nightstand',  url: 'https://www.roveconcepts.com/modern-nightstands.html' },
  { room: 'bedroom',     cat: 'dresser',     url: 'https://www.roveconcepts.com/modern-dressers.html' },
  // Dining room
  { room: 'dining room', cat: 'dining table',url: 'https://www.roveconcepts.com/modern-dining-tables.html' },
  { room: 'dining room', cat: 'dining chair',url: 'https://www.roveconcepts.com/mid-century-modern-dining-chairs.html' },
  { room: 'dining room', cat: 'sideboard',   url: 'https://www.roveconcepts.com/modern-sideboards.html' },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function inchesToMetres(n) { return Math.round(n * 0.0254 * 100) / 100; }

function cleanName(raw) {
  return (raw || '').replace(/\s*\|\s*Rove Concepts.*$/i, '').trim();
}

function slugify(text) {
  return (text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(msg);
  await appendFile(LOG_PATH, line + '\n').catch(() => {});
}

async function delay(ms) { return new Promise(r => setTimeout(r, ms + Math.random() * 400)); }

// ── Page scraping ─────────────────────────────────────────────────────────────

async function scrapeCategory(page, catInfo) {
  await log(`  Fetching category: ${catInfo.cat} (${catInfo.url})`);
  await page.goto(catInfo.url, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(1000);

  const products = await page.evaluate(() => {
    return [...document.querySelectorAll('.product_listing')].map(el => ({
      name: el.querySelector('.product_title a')?.textContent?.trim(),
      url:  el.querySelector('.product_title a')?.href,
      thumbUrl: el.querySelector('img')?.src || el.querySelector('img')?.getAttribute('data-src'),
    })).filter(p => p.name && p.url);
  });

  await log(`    Found ${products.length} products`);
  return products;
}

async function scrapeProduct(page, productUrl, catInfo) {
  await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(800);

  return await page.evaluate((catInfo) => {
    // ── JSON-LD ──
    const ld = [...document.querySelectorAll('script[type="application/ld+json"]')]
      .map(s => { try { return JSON.parse(s.textContent); } catch { return null; } })
      .filter(Boolean)
      .find(d => d['@type'] === 'Product');

    const rawName  = ld?.name || document.querySelector('h1')?.textContent?.trim();
    const name     = (rawName || '').replace(/\s*\|\s*Rove Concepts.*$/i, '').trim();
    const rawPrice = ld?.offers?.price || ld?.offers?.[0]?.price;
    const price    = rawPrice ? `$${parseFloat(rawPrice).toLocaleString('en-US', { minimumFractionDigits: 0 })}` : null;
    const mainImg  = Array.isArray(ld?.image) ? ld.image[0] : ld?.image;
    const productUrl = ld?.url || window.location.href;
    const description = ld?.description?.trim() || null;

    // ── Dimensions from specs table ──
    // Rove Concepts renders: "94.4 in x 39.4 in x 31.5 in" in a spec element
    const specEls = [...document.querySelectorAll('[class*=spec],[class*=dimension],[class*=detail]')];
    let dimsIn = null;
    for (const el of specEls) {
      const t = el.textContent;
      const m = t.match(/(\d+(?:\.\d+)?)\s*in\s*x\s*(\d+(?:\.\d+)?)\s*in\s*x\s*(\d+(?:\.\d+)?)\s*in/i);
      if (m) { dimsIn = [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])]; break; }
    }
    // Fallback: scan body text
    if (!dimsIn) {
      const bodyT = document.body.innerText;
      const m = bodyT.match(/(\d+(?:\.\d+)?)\s*in\s*x\s*(\d+(?:\.\d+)?)\s*in\s*x\s*(\d+(?:\.\d+)?)\s*in/i);
      if (m) dimsIn = [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
    }

    // ── Materials from spec block ──
    const specText = specEls.map(e => e.textContent).join(' ');
    const matMatch = specText.match(/(?:Material|Fabric|Upholstery|Frame)[s]?\s*[:\-]\s*([^\n,;]+)/i);
    const materials = matMatch ? [matMatch[1].trim()] : [];

    // ── Product gallery images (official product shots only) ──
    const imageUrls = [
      ...(mainImg ? [mainImg] : []),
      ...[...document.querySelectorAll('img')]
        .map(i => i.src || i.getAttribute('data-src') || '')
        .filter(s => s.includes('uc_product') || s.includes('styles/product'))
        .filter(s => s !== mainImg)
    ].filter(Boolean).slice(0, 6);

    // ── Colors — look for swatch/option elements ──
    const colorEls = [...document.querySelectorAll('[class*=swatch] [title],[class*=color] [title],[class*=option] [title]')];
    const colors = [...new Set(colorEls.map(e => e.getAttribute('title')).filter(Boolean))].slice(0, 12);

    // ── Style guess ──
    const haystack = (name + ' ' + (description || '')).toLowerCase();
    const style = haystack.includes('mid-century') || haystack.includes('mid century') ? 'mid-century'
                : haystack.includes('scandinavian') ? 'scandinavian'
                : haystack.includes('industrial')   ? 'industrial'
                : haystack.includes('traditional')  ? 'traditional'
                : haystack.includes('contemporary') || haystack.includes('modern') ? 'modern'
                : 'other';

    return {
      name, price, dimsIn, materials, colors, style,
      imageUrls, productUrl, description,
      catInfo,
    };
  }, catInfo);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  await log('=== Rove Concepts catalogue scraper starting ===');
  await log(`Resume mode: ${RESUME}`);

  // Load existing catalogue if resuming
  let existing = [];
  if (RESUME && existsSync(OUT_PATH)) {
    const raw = JSON.parse(await readFile(OUT_PATH, 'utf8'));
    existing = raw.products || [];
    await log(`Loaded ${existing.length} existing products (will skip duplicates)`);
  }
  const seenUrls = new Set(existing.map(p => p.productUrl));

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  const products = [...existing];
  let newCount = 0;
  let errorCount = 0;

  try {
    for (const catInfo of CATEGORIES) {
      await log(`\n── ${catInfo.room.toUpperCase()} / ${catInfo.cat} ──────────────`);

      let productLinks;
      try {
        productLinks = await scrapeCategory(page, catInfo);
      } catch (err) {
        await log(`  ✗ Category page failed: ${err.message}`);
        errorCount++;
        continue;
      }

      for (const link of productLinks) {
        if (seenUrls.has(link.url)) {
          await log(`  → skip (already have): ${link.name}`);
          continue;
        }

        await log(`  Scraping: ${link.name}`);
        await delay(DELAY_MS);

        try {
          const data = await scrapeProduct(page, link.url, catInfo);

          const toMetres = n => Math.round(n * 0.0254 * 100) / 100;
          const [wIn, dIn, hIn] = data.dimsIn || [null, null, null];

          const product = {
            id:          slugify(data.name || link.name),
            name:        data.name || link.name,
            price:       data.price,
            category:    catInfo.cat,
            room:        catInfo.room,
            style:       data.style,
            materials:   data.materials,
            colors:      data.colors,
            dimensions: wIn ? {
              widthIn:  wIn,  depthIn:  dIn,  heightIn: hIn,
              width:    toMetres(wIn), depth: toMetres(dIn), height: toMetres(hIn),
              unit: 'm',
            } : null,
            imageUrls:   data.imageUrls,
            productUrl:  link.url,
            source:      'rove-concepts',
            description: data.description,
            scrapedAt:   new Date().toISOString(),
          };

          products.push(product);
          seenUrls.add(link.url);
          newCount++;

          const dimsLabel = wIn ? `${wIn}"W × ${dIn}"D × ${hIn}"H` : 'dims n/a';
          await log(`  ✓ ${product.name} | ${product.price || 'price n/a'} | ${dimsLabel} | ${product.imageUrls.length} img(s)`);

          // Save incrementally so a crash doesn't lose progress
          await writeFile(OUT_PATH, JSON.stringify({
            version: '1.0',
            source:  'rove-concepts',
            builtAt: new Date().toISOString(),
            total:   products.length,
            products,
          }, null, 2));

        } catch (err) {
          await log(`  ✗ Failed: ${link.name} — ${err.message}`);
          errorCount++;
        }
      }
    }
  } finally {
    await browser.close();
  }

  await log(`\n=== Done — ${newCount} new products scraped, ${errorCount} errors ===`);
  await log(`Total catalogue: ${products.length} products → ${OUT_PATH}`);

  // Print summary by room/category
  const byRoom = {};
  for (const p of products) {
    if (!byRoom[p.room]) byRoom[p.room] = {};
    if (!byRoom[p.room][p.category]) byRoom[p.room][p.category] = 0;
    byRoom[p.room][p.category]++;
  }
  console.log('\nCatalogue summary:');
  for (const [room, cats] of Object.entries(byRoom)) {
    console.log(`  ${room}:`);
    for (const [cat, count] of Object.entries(cats)) {
      console.log(`    ${cat}: ${count} items`);
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
