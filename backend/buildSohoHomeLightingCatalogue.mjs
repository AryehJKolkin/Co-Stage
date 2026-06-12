#!/usr/bin/env node
/**
 * Soho Home Lighting catalogue scraper
 * Covers: table lamps, floor lamps, wall lights/sconces,
 *         chandeliers, pendants, portable/side lamps.
 * Uses same technique as buildSohoHomeCatalogue.mjs:
 *   - Scroll listing pages to collect product URLs
 *   - Visit each product page and parse JSON-LD schema.org Product
 * Usage:  node buildSohoHomeLightingCatalogue.mjs
 *         node buildSohoHomeLightingCatalogue.mjs --resume
 * Output: ../soho-home-lighting-catalogue.json
 */

import puppeteer from 'puppeteer';
import { writeFile, readFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH  = path.join(__dirname, '..', 'soho-home-lighting-catalogue.json');
const LOG_PATH  = path.join(__dirname, '..', 'scrapers', 'sohohome-lighting-scrape.log');
const RESUME    = process.argv.includes('--resume');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE      = 'https://www.sohohome.com';
const MAX_PER_CAT = 20;
const delay = ms => new Promise(r => setTimeout(r, ms + Math.random() * 200));

// ── Listing pages per lighting category ───────────────────────────────────────

const CATEGORIES = [
  {
    cat: 'table lamp',
    urls: ['/us/lighting/table-lamps'],
  },
  {
    cat: 'floor lamp',
    urls: ['/us/lighting/floor-lamps'],
  },
  {
    cat: 'wall light',   // covers wall lamps + sconces
    urls: ['/us/lighting/wall-lights'],
  },
  {
    cat: 'chandelier',
    urls: [
      '/us/lighting/ceiling-lights?product_type=Chandelier',
      '/us/lighting/ceiling-lights?product_type=Multi+Arm+Chandeliers',
    ],
  },
  {
    cat: 'pendant',
    urls: ['/us/lighting/ceiling-lights?product_type=Pendant+Light'],
  },
  {
    cat: 'portable lamp',   // side lamps, rechargeable, accent
    urls: ['/us/lighting/portable-lamps'],
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(t) { return (t||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,''); }
function cmToMetres(cm) { return Math.round(cm / 100 * 100) / 100; }
function cmToInches(cm) { return Math.round(cm / 2.54 * 10) / 10; }

async function log(msg) {
  console.log(msg);
  await appendFile(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`).catch(()=>{});
}

// ── Collect product links from a listing page ─────────────────────────────────

async function getProductLinks(page, url) {
  await log(`  Loading: ${url}`);
  await page.goto(BASE + url, { waitUntil: 'networkidle2', timeout: 40000 });
  await delay(1000);

  // Scroll to trigger lazy-loaded products
  for (let i = 0; i < 14; i++) {
    await page.evaluate(() => window.scrollBy(0, 700));
    await delay(350);
  }
  await delay(1500);

  const items = await page.evaluate(() =>
    [...document.querySelectorAll('a.product__link')].map(a => {
      const article = a.closest('article');
      let ee = {};
      try { ee = JSON.parse(article?.dataset?.ee || '{}'); } catch {}
      return {
        href: a.href,
        name: a.textContent.trim().replace(/\s+/g, ' '),
        slug: a.href.split('/products/')[1]?.split(/[?#]/)[0] || '',
        eeCategory: ee.category || '',
      };
    }).filter(i => i.slug)
  );

  await log(`  Found ${items.length} product links`);
  return items;
}

// ── Scrape a product page for JSON-LD data ────────────────────────────────────

async function scrapeProduct(page, href) {
  await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await delay(700);

  return page.evaluate(() => {
    const scripts = [...document.querySelectorAll('script[type="application/ld+json"]')];
    let ld = null;
    for (const s of scripts) {
      try {
        const d = JSON.parse(s.textContent);
        if (d['@type'] === 'Product') { ld = d; break; }
      } catch {}
    }

    // Gallery images
    const galleryImgs = [
      ...document.querySelectorAll('.product__gallery img, [class*=gallery] img, [class*=product__image] img')
    ].map(i => i.src || i.dataset.src).filter(s => s && s.includes('sohohome'));
    const mainImg = ld?.image || '';
    const allImgs = [mainImg, ...galleryImgs].filter(Boolean);
    const uniqueImgs = [...new Set(allImgs)].slice(0, 4);

    // Description
    const descEl = document.querySelector('[class*=product__description],[class*=description],[itemprop=description]');
    const desc = descEl?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 500) || '';

    const price = ld?.offers?.price ? `$${parseFloat(ld.offers.price).toLocaleString()}` : null;

    // Dimensions: Soho Home uses width/depth/height in cm on JSON-LD
    // For lighting, they also use "height" and sometimes "diameter"
    const wCm = ld?.width?.value  ? parseFloat(ld.width.value)  : null;
    const dCm = ld?.depth?.value  ? parseFloat(ld.depth.value)  : null;
    const hCm = ld?.height?.value ? parseFloat(ld.height.value) : null;

    // Some lighting items have diameter instead of width
    const diam = ld?.diameter?.value ? parseFloat(ld.diameter.value) : null;

    return {
      name:        ld?.name || document.querySelector('h1')?.textContent?.trim() || null,
      price,
      priceRaw:    ld?.offers?.price || null,
      widthCm:     wCm || diam || null,
      depthCm:     dCm,
      heightCm:    hCm,
      diameterCm:  diam,
      color:       ld?.color || null,
      material:    ld?.material || null,
      imageUrls:   uniqueImgs,
      description: desc,
      sku:         ld?.sku || null,
    };
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  await log('=== Soho Home Lighting catalogue scraper ===');

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
  const page = await browser.newPage();
  await page.setUserAgent(UA);

  const products = [...existing];
  let newCount = 0, errorCount = 0;

  try {
    for (const catInfo of CATEGORIES) {
      await log(`\n══ ${catInfo.cat.toUpperCase()} ══════════════`);

      // Collect product links across all URLs for this category
      const allItems = [];
      for (const url of catInfo.urls) {
        try {
          const items = await getProductLinks(page, url);
          allItems.push(...items);
        } catch (err) {
          await log(`  ✗ Listing failed: ${err.message.slice(0, 80)}`);
          errorCount++;
        }
        await delay(800);
      }

      // De-duplicate
      const seen = new Set();
      const deduped = allItems.filter(i => {
        if (seen.has(i.slug)) return false;
        seen.add(i.slug);
        return true;
      });

      let catCount = 0;
      for (const item of deduped) {
        if (seenSlugs.has(item.slug)) { await log(`  → skip: ${item.slug}`); continue; }
        if (catCount >= MAX_PER_CAT) break;

        await log(`  Scraping: ${item.slug}`);
        await delay(700);

        try {
          const data = await scrapeProduct(page, item.href);

          const wCm = data.widthCm, dCm = data.depthCm, hCm = data.heightCm;
          const wIn = wCm ? cmToInches(wCm) : null;
          const dIn = dCm ? cmToInches(dCm) : null;
          const hIn = hCm ? cmToInches(hCm) : null;

          const hay = ((data.name || '') + (data.description || '')).toLowerCase();
          const style =
            /art deco|deco/.test(hay)          ? 'art deco'
            : /mid-century|mid century/.test(hay) ? 'mid-century'
            : /industrial|cage|pipe/.test(hay)   ? 'industrial'
            : /scandinavian|nordic/.test(hay)    ? 'scandinavian'
            : /traditional|classic/.test(hay)    ? 'traditional'
            : /modern|contemporary|minimal/.test(hay) ? 'modern' : 'other';

          const colors = data.color
            ? data.color.split(/,\s*|\s+and\s+/).map(c => c.trim()).filter(Boolean)
            : [];
          const materials = data.material
            ? data.material.split(/,\s*|\s+and\s+/).map(m => m.trim()).filter(Boolean)
            : [];

          const product = {
            id:       slugify(data.name || item.slug),
            slug:     item.slug,
            name:     data.name || item.name,
            price:    data.price,
            priceRaw: data.priceRaw,
            category: catInfo.cat,
            room:     'lighting',
            style,
            colors,
            materials,
            dimensions: hCm ? {
              widthCm:  wCm, depthCm: dCm, heightCm: hCm,
              widthIn:  wIn, depthIn: dIn, heightIn: hIn,
              diameterCm: data.diameterCm || null,
              width:    wCm ? cmToMetres(wCm) : null,
              depth:    dCm ? cmToMetres(dCm) : null,
              height:   cmToMetres(hCm),
              unit: 'm',
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
          catCount++;
          newCount++;

          const dimsLabel = hCm
            ? `${wCm}cm W × ${dCm || '?'}cm D × ${hCm}cm H`
            : 'dims n/a';
          await log(`  ✓ ${product.name} | ${product.price || '—'} | ${dimsLabel} | ${product.imageUrls.length} imgs`);

          await writeFile(OUT_PATH, JSON.stringify({
            version: '1.0', source: 'soho-home-lighting',
            builtAt: new Date().toISOString(), total: products.length, products,
          }, null, 2));

        } catch (err) {
          await log(`  ✗ ${item.slug}: ${err.message.slice(0, 80)}`);
          errorCount++;
        }
      }
    }
  } finally {
    await browser.close();
  }

  await log(`\n=== Done — ${newCount} new, ${errorCount} errors, ${products.length} total ===`);

  const byCat = {};
  products.forEach(p => { byCat[p.category] = (byCat[p.category] || 0) + 1; });
  console.log('\nSummary:');
  for (const [c, n] of Object.entries(byCat)) console.log(`  ${c}: ${n}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
