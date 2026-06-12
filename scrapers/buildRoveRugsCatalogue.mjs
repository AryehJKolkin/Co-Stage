#!/usr/bin/env node
/**
 * Rove Concepts rugs scraper
 *
 * Site is server-rendered static HTML, so this fetches pages directly
 * (no Puppeteer needed). Pulls all rugs from the "Modern Rugs & Poufs"
 * listing page and appends them to rove-concepts-catalogue.json under
 * room: 'living room', category: 'rug'.
 *
 * Usage:
 *   node scrapers/buildRoveRugsCatalogue.mjs
 *   node scrapers/buildRoveRugsCatalogue.mjs --resume   (skip products already saved)
 *
 * Output: rove-concepts-catalogue.json  (repo root)
 * Logs:   scrapers/rove-rugs-scrape.log
 */

import { writeFile, readFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH  = path.join(__dirname, '..', 'rove-concepts-catalogue.json');
const LOG_PATH  = path.join(__dirname, 'rove-rugs-scrape.log');
const RESUME    = process.argv.includes('--resume');
const UA        = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LISTING_URL = 'https://www.roveconcepts.com/modern-rugs-poufs.html';
const BASE = 'https://www.roveconcepts.com';

function inchesToMetres(n) { return Math.round(n * 0.0254 * 100) / 100; }
function metresToInches(n) { return Math.round(n / 0.0254 * 10) / 10; }
function slugify(t) { return (t||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,''); }

async function log(msg) {
  console.log(msg);
  await appendFile(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`).catch(()=>{});
}
const delay = ms => new Promise(r => setTimeout(r, ms + Math.random()*400));

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  return res.text();
}

async function getRugLinks() {
  const html = await fetchHtml(LISTING_URL);
  const re = /href="(\/[a-z0-9-]+-rug)"/gi;
  const set = new Set();
  let m;
  while ((m = re.exec(html))) set.add(m[1]);
  return [...set];
}

function detectStyle(text) {
  const t = (text||'').toLowerCase();
  return /mid-century|mid century/.test(t) ? 'mid-century'
       : /scandinavian|nordic/.test(t) ? 'scandinavian'
       : /industrial/.test(t) ? 'industrial'
       : /traditional|classic/.test(t) ? 'traditional'
       : /modern|contemporary|minimalist/.test(t) ? 'modern' : 'other';
}

function parseProduct(html) {
  // JSON-LD Product
  let ld = null;
  for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    try { const d = JSON.parse(m[1]); if (d['@type'] === 'Product') { ld = d; break; } } catch {}
  }

  const name = (ld?.name || '').replace(/\s*\|\s*Rove Concepts.*$/i, '').trim();
  const priceRaw = ld?.offers?.price ? parseFloat(ld.offers.price) : null;
  const price = priceRaw != null ? `$${Math.round(priceRaw).toLocaleString('en-US')}` : null;
  const description = ld?.description?.trim()?.replace(/\s+/g,' ') || null;
  const sku = ld?.sku || null;

  // Size dropdown selected option, e.g. `5' x 7'6" | 1.5 x 2.3m`
  let widthM = null, heightM = null;
  const sizeMatch = html.match(/<option value="\d+" selected="selected">[^<]*\|\s*([\d.]+)\s*x\s*([\d.]+)\s*m<\/option>/i);
  if (sizeMatch) {
    const a = parseFloat(sizeMatch[1]), b = parseFloat(sizeMatch[2]);
    widthM = Math.max(a,b); heightM = Math.min(a,b);
  }

  // Color/pattern dropdown options (exclude size options which contain '|')
  const colors = [...new Set(
    [...html.matchAll(/<option value="\d+"[^>]*>([^<|]+)<\/option>/g)]
      .map(m => m[1].trim())
      .filter(c => c && !/\bx\b/i.test(c))
  )];

  // Product gallery images — filename prefixed with the rug's name, excluding swatches
  const namePrefix = (name.split(' ')[0] || '').replace(/[^a-zA-Z0-9]/g,'');
  let imageUrls = [];
  if (namePrefix) {
    const imgRe = new RegExp(`https://cdn\\.roveconcepts\\.com/sites/default/files/styles/picture_1024_1x/public/${namePrefix}[^"'\\s]*\\.jpg`, 'gi');
    imageUrls = [...new Set([...html.matchAll(imgRe)].map(m => m[0]))]
      .filter(u => !u.includes('/swatch/'));
  }
  if (!imageUrls.length && ld?.image) {
    imageUrls = [Array.isArray(ld.image) ? ld.image[0] : ld.image].filter(Boolean);
  }
  imageUrls = imageUrls.slice(0, 6);

  // Materials
  const materials = [];
  if (/\bwool\b/i.test(html)) materials.push('Wool');
  else if (/\bjute\b/i.test(html)) materials.push('Jute');
  else if (/\bviscose\b/i.test(html)) materials.push('Viscose');
  else if (/\bcotton\b/i.test(html)) materials.push('Cotton');
  else if (/\bpolyester\b/i.test(html)) materials.push('Polyester');

  return { name, price, priceRaw, description, sku, widthM, heightM, colors, imageUrls, materials };
}

async function main() {
  await log('=== Rove Concepts rugs scraper starting ===');

  let existing = [];
  if (RESUME && existsSync(OUT_PATH)) {
    existing = JSON.parse(await readFile(OUT_PATH, 'utf8')).products || [];
    await log(`Loaded ${existing.length} existing products`);
  }
  const seenUrls = new Set(existing.map(p => p.productUrl));

  const links = await getRugLinks();
  await log(`Found ${links.length} rug links`);

  const products = [...existing];
  let newCount = 0, errorCount = 0;

  for (const href of links) {
    const productUrl = BASE + href;
    if (seenUrls.has(productUrl)) { await log(`  → skip (already have): ${href}`); continue; }

    await log(`  Scraping: ${href}`);
    await delay(800);

    try {
      const html = await fetchHtml(productUrl);
      const data = parseProduct(html);
      if (!data.name) throw new Error('No JSON-LD product name found');

      const dimensions = data.widthM != null ? {
        widthIn: metresToInches(data.widthM), depthIn: metresToInches(0.01), heightIn: metresToInches(data.heightM),
        width: data.widthM, depth: 0.01, height: data.heightM,
        unit: 'm',
      } : null;

      const product = {
        id: slugify(data.name),
        name: data.name,
        price: data.price,
        priceRaw: data.priceRaw,
        category: 'rug',
        room: 'living room',
        style: detectStyle(`${data.name} ${data.description || ''}`),
        materials: data.materials,
        colors: data.colors,
        dimensions,
        imageUrls: data.imageUrls,
        productUrl,
        source: 'rove-concepts',
        description: data.description,
        sku: data.sku,
        scrapedAt: new Date().toISOString(),
      };

      products.push(product);
      seenUrls.add(productUrl);
      newCount++;

      const dimsLabel = dimensions ? `${dimensions.width}m × ${dimensions.height}m` : 'dims n/a';
      await log(`  ✓ ${product.name} | ${product.price || '—'} | ${dimsLabel} | ${product.imageUrls.length} imgs`);

      await writeFile(OUT_PATH, JSON.stringify({
        version: '1.0', source: 'rove-concepts',
        builtAt: new Date().toISOString(), total: products.length, products,
      }, null, 2));

    } catch (err) {
      await log(`  ✗ ${href}: ${err.message}`);
      errorCount++;
    }
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
