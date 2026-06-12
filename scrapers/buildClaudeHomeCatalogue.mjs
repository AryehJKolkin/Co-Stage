#!/usr/bin/env node
/**
 * Claude Home catalogue builder — pure API, no browser needed
 * Uses Shopify's public /collections/{handle}/products.json endpoint.
 * Usage:  node scrapers/buildClaudeHomeCatalogue.mjs
 *         node scrapers/buildClaudeHomeCatalogue.mjs --resume
 * Output: claude-home-catalogue.json  (repo root)
 */

import { writeFile, readFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH  = path.join(__dirname, '..', 'claude-home-catalogue.json');
const LOG_PATH  = path.join(__dirname, 'claudehome-scrape.log');
const RESUME    = process.argv.includes('--resume');
const BASE      = 'https://claudehome.com';
const MAX_PER_CAT = 20;
const delay = ms => new Promise(r => setTimeout(r, ms));

// ── Category → Shopify collection handles ────────────────────────────────────

const CATEGORIES = [
  { room: 'living room', cat: 'sofa',         collections: ['sofas', 'corner-sectional-sofas'] },
  { room: 'living room', cat: 'armchair',     collections: ['armchairs'] },
  { room: 'living room', cat: 'coffee table', collections: ['coffee-tables'] },
  { room: 'living room', cat: 'side table',   collections: ['end-tables-side-tables'] },
  { room: 'living room', cat: 'tv unit',      collections: ['media-furniture'] },
  { room: 'bedroom',     cat: 'bed',          collections: ['beds_and_bedframes'] },
  { room: 'bedroom',     cat: 'nightstand',   collections: ['nightstands'] },
  { room: 'bedroom',     cat: 'dresser',      collections: ['dressers'] },
  { room: 'dining room', cat: 'dining table', collections: ['dining-tables'] },
  { room: 'dining room', cat: 'dining chair', collections: ['dining-chairs'] },
  { room: 'dining room', cat: 'sideboard',    collections: ['sideboards'] },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(t) { return (t||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,''); }
function stripHtml(html) { return (html||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim(); }

async function log(msg) {
  console.log(msg);
  await appendFile(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`).catch(()=>{});
}

async function shopifyFetch(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CoStage/1.0)', 'Accept': 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchCollectionProducts(handle) {
  const products = [];
  let page = 1;
  while (true) {
    const url = `${BASE}/collections/${handle}/products.json?limit=250&page=${page}`;
    const data = await shopifyFetch(url);
    const batch = data.products || [];
    products.push(...batch);
    if (batch.length < 250) break;
    page++;
    await delay(300);
  }
  return products;
}

function transformProduct(p, cat, room) {
  // Price: lowest non-sample variant price
  const realVariants = p.variants.filter(v => {
    const t = (v.title||'').toLowerCase();
    return !t.includes('sample') && parseFloat(v.price) > 50;
  });
  const lowestVariant = realVariants.sort((a,b) => parseFloat(a.price)-parseFloat(b.price))[0];
  const priceRaw = lowestVariant ? parseFloat(lowestVariant.price) : parseFloat(p.variants[0]?.price||0);
  const price = priceRaw ? `$${priceRaw.toLocaleString()}` : null;

  // Colors / materials from option values (skip sample options)
  const colors = [];
  const materials = [];
  for (const opt of p.options||[]) {
    const vals = (opt.values||[]).filter(v => !v.toLowerCase().includes('sample') && !v.toLowerCase().includes('default'));
    if (/color|colour/i.test(opt.name)) colors.push(...vals);
    else if (/material|fabric|finish/i.test(opt.name)) materials.push(...vals);
    else if (vals.length <= 12) colors.push(...vals); // treat other options as variant labels
  }

  // Images — up to 4, prefer non-swatch
  const imageUrls = (p.images||[])
    .filter(i => i.src && !i.src.includes('swatch'))
    .slice(0, 4)
    .map(i => i.src);

  // Description
  const description = stripHtml(p.body_html).slice(0, 500) || null;

  // Style detection
  const tagsStr = Array.isArray(p.tags) ? p.tags.join(' ') : (p.tags||'');
  const hay = (p.title + ' ' + description + ' ' + tagsStr).toLowerCase();
  const style = /mid-century|mid century|1960|1970|1950|vintage/.test(hay) ? 'mid-century'
              : /scandinavian|nordic|danish/.test(hay) ? 'scandinavian'
              : /industrial/.test(hay) ? 'industrial'
              : /traditional|classic|antique/.test(hay) ? 'traditional'
              : /modern|contemporary|minimalist/.test(hay) ? 'modern' : 'other';

  return {
    id:          slugify(p.title),
    handle:      p.handle,
    name:        p.title,
    price,
    priceRaw,
    category:    cat,
    room,
    style,
    colors:      [...new Set(colors)].slice(0, 12),
    materials:   [...new Set(materials)].slice(0, 6),
    dimensions:  null, // Claude Home does not publish dimensions
    imageUrls,
    productUrl:  `${BASE}/products/${p.handle}`,
    source:      'claude-home',
    description,
    sku:         p.variants[0]?.sku || null,
    tags:        (Array.isArray(p.tags) ? p.tags : (p.tags||'').split(', ')).filter(Boolean).slice(0, 10),
    scrapedAt:   new Date().toISOString(),
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  await log('=== Claude Home catalogue builder ===');

  let existing = [];
  if (RESUME && existsSync(OUT_PATH)) {
    existing = JSON.parse(await readFile(OUT_PATH,'utf8')).products || [];
    await log(`Resuming — ${existing.length} existing products`);
  }
  const seenHandles = new Set(existing.map(p => p.handle));

  const products = [...existing];
  let newCount = 0;

  for (const catInfo of CATEGORIES) {
    await log(`\n── ${catInfo.room.toUpperCase()} / ${catInfo.cat} ──────────────`);
    const allItems = [];

    for (const handle of catInfo.collections) {
      await log(`  Fetching collection: ${handle}`);
      try {
        const items = await fetchCollectionProducts(handle);
        await log(`    ${items.length} products`);
        allItems.push(...items);
        await delay(400);
      } catch(err) {
        await log(`  ✗ ${handle}: ${err.message}`);
      }
    }

    // De-duplicate by handle, prefer newer entries
    const deduped = [];
    const seen = new Set();
    for (const p of allItems) {
      if (!seen.has(p.handle)) { seen.add(p.handle); deduped.push(p); }
    }

    let catCount = 0;
    for (const p of deduped) {
      if (seenHandles.has(p.handle)) { continue; }
      if (catCount >= MAX_PER_CAT) break;

      const product = transformProduct(p, catInfo.cat, catInfo.room);
      products.push(product);
      seenHandles.add(p.handle);
      newCount++;
      catCount++;

      await log(`  ✓ ${product.name} | ${product.price||'—'} | ${product.imageUrls.length} imgs | ${product.colors.slice(0,3).join(', ')}`);
    }

    await writeFile(OUT_PATH, JSON.stringify({
      version: '1.0', source: 'claude-home',
      builtAt: new Date().toISOString(), total: products.length, products,
    }, null, 2));
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
