#!/usr/bin/env node
/**
 * West Elm catalogue scraper — run from backend/ directory
 * Strategy: fetch West Elm's bestsellers.txt (product slug list), classify each
 *           slug into room/category, then pull data via dream-pip API.
 * Usage:  node buildWestElmCatalogue.mjs
 *         node buildWestElmCatalogue.mjs --resume
 * Output: ../west-elm-catalogue.json
 */

import puppeteer from 'puppeteer';
import { writeFile, readFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH  = path.join(__dirname, '..', 'west-elm-catalogue.json');
const LOG_PATH  = path.join(__dirname, '..', 'scrapers', 'westelm-scrape.log');
const RESUME    = process.argv.includes('--resume');
const UA        = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_PER_CAT = 25;

// ── Category classification ───────────────────────────────────────────────────

function classifySlug(slug) {
  const s = slug.toLowerCase();

  // Rugs — must come before the general exclusion list
  if (/\brug\b|area-rug|-rug$|-rug-/.test(s)) return { room: 'living room', cat: 'rug' };

  // Skip non-furniture items
  if (/curtain|pillow|throw|quilt|duvet|sheet|towel|candle|vase|frame|mirror|lamp|lighting|planter|basket|tray|art|bar-cart|wine-rack|bath|outdoor|kids|nursery|baby|teen|hardware|faucet|sink|toilet|wall-sconce|pendant|chandelier|floor-lamp|table-lamp|desk-lamp|ceiling|fan|cord|plug|diffuser|canister|catch-all|umbrella|pet/.test(s)) return null;
  if (/book-end|book-tray|bookend/.test(s)) return null;

  // New categories
  if (/bar-stool|barstool|counter-stool/.test(s)) return { room: 'dining room', cat: 'barstool' };
  if (/bench/.test(s) && !/dining-bench/.test(s)) return { room: 'bedroom', cat: 'bench' };
  if (/bookcase|bookshelf|etagere|shelving|open-shelf/.test(s)) return { room: 'living room', cat: 'shelving' };
  if (/-desk-|-desk$|writing-desk|secretary-desk/.test(s) && !/desk-lamp/.test(s)) return { room: 'other', cat: 'desk' };

  // Dining room
  if (/buffet|sideboard/.test(s)) return { room: 'dining room', cat: 'sideboard' };
  if (/dining-chair|dining-bench|dining-stool/.test(s)) return { room: 'dining room', cat: 'dining chair' };
  if (/dining-table|dining-desk|round-dining/.test(s)) return { room: 'dining room', cat: 'dining table' };

  // Bedroom
  if (/nightstand|night-stand/.test(s)) return { room: 'bedroom', cat: 'nightstand' };
  if (/dresser|armoire|chest-of-drawer/.test(s)) return { room: 'bedroom', cat: 'dresser' };
  if (/-bed-|-bed$|bedframe|headboard/.test(s)) return { room: 'bedroom', cat: 'bed' };

  // Living room
  if (/media-console|tv-stand|tv-console/.test(s)) return { room: 'living room', cat: 'tv unit' };
  if (/coffee-table|cocktail-table/.test(s)) return { room: 'living room', cat: 'coffee table' };
  if (/side-table|end-table|drink-table|accent-table/.test(s)) return { room: 'living room', cat: 'side table' };
  if (/sectional|sleeper-sofa|-sofa-|-sofa$/.test(s)) return { room: 'living room', cat: 'sofa' };
  if (/recliner|lounge-chair|swivel-chair|armchair|wingchair|wing-chair|slipper-chair|accent-chair/.test(s)) return { room: 'living room', cat: 'armchair' };
  if (/-chair-|-chair$/.test(s) && !/-dining-chair|-side-chair|-office-chair|-bar-chair|-counter-chair/.test(s)) return { room: 'living room', cat: 'armchair' };

  return null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(t) { return (t||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,''); }
function inchesToMetres(n) { return Math.round(n*0.0254*100)/100; }

function parseDimsFromHtml(html) {
  const clean = html.replace(/&quot;/g,'"').replace(/<[^>]+>/g,' ');
  const m = clean.match(/(\d+(?:\.\d+)?)["\s]*w\s*x\s*(\d+(?:\.\d+)?)["\s]*d\s*x\s*(\d+(?:\.\d+)?)["\s]*h/i);
  return m ? [parseFloat(m[1]),parseFloat(m[2]),parseFloat(m[3])] : null;
}

async function log(msg) {
  console.log(msg);
  await appendFile(LOG_PATH, `[${new Date().toISOString()}] ${msg}\n`).catch(()=>{});
}
const delay = ms => new Promise(r => setTimeout(r, ms + Math.random()*300));

// ── Fetch bestsellers slug list ───────────────────────────────────────────────

async function fetchBestsellers(page) {
  await log('Fetching bestsellers.txt from West Elm...');
  await page.goto('https://www.westelm.com/', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await delay(800);

  // Find today's bestsellers.txt URL from a recent date range
  const today = new Date();
  const txt = await page.evaluate(async () => {
    // Try today and the past 7 days
    for (let i = 0; i < 8; i++) {
      const d = new Date(Date.now() - i * 86400000);
      const y = d.getFullYear(), mo = String(d.getMonth()+1).padStart(2,'0'), dy = String(d.getDate()).padStart(2,'0');
      const url = `/netstorage/images/ossa/${y}/${mo}/${dy}/bestsellers.txt`;
      const r = await fetch(url);
      if (r.ok) { return { url, text: await r.text() }; }
    }
    return null;
  });

  if (!txt) throw new Error('Could not find bestsellers.txt for the past 8 days');
  await log(`  Found: ${txt.url} (${txt.text.length} bytes)`);
  return txt.text;
}

// ── Product data — navigate to JSON APIs directly (avoids detached-frame issues) ──

async function navJson(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  const text = await page.evaluate(() => document.body.innerText);
  return JSON.parse(text);
}

async function fetchProductData(page, slug) {
  const pip   = await navJson(page, `https://www.westelm.com/api/catalog/v1/groups/${slug}/dream-pip.json`);
  const attrs = await navJson(page, `https://www.westelm.com/api/catalog/v1/groups/${slug}/subsets/0/attributes.json`);

  let dimsIn = null;
  for (const d of pip.dimensions||[]) { const p=parseDimsFromHtml(d.content||''); if(p){dimsIn=p;break;} }

  const imageUrls = (pip.lifeStyleImages||[]).filter(i=>i.path).slice(0,4)
    .map(i=>`https://asset.wsimgs.com/wsimgs/ab/images/${i.path}xxxx.jpg`);

  const description = (pip.contentBlocks?.productBlurb||'')
    .replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0,500)||null;

  const colorAttr = (attrs.attributeTypes||[]).find(a=>a.id==='color'||/color|material/i.test(a.name||''));
  const colors = (colorAttr?.attributeValues||[]).map(v=>v.name?.replace(/&quot;/g,'"')).filter(Boolean).slice(0,12);

  const sizeAttr = (attrs.attributeTypes||[]).find(a=>a.id==='furnitureSize'||/size/i.test(a.name||''));
  const sizes = (sizeAttr?.attributeValues||[]).map(v=>v.name?.replace(/&quot;/g,'"')).filter(Boolean).slice(0,6);

  return { dimsIn, imageUrls, description, colors, sizes };
}

async function getNameAndPrice(page, slug) {
  await page.goto(`https://www.westelm.com/products/${slug}/`, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await delay(1500);
  await page.waitForFunction(() => !!document.querySelector('h1'), { timeout: 5000 }).catch(()=>{});
  return page.evaluate(() => {
    const name = document.querySelector('h1')?.textContent?.trim()
              || document.title.replace(/\s*[|–-].*$/,'').trim();
    const priceEl = document.querySelector('[class*=price],[data-price],[itemprop=price]');
    let price = priceEl?.textContent?.trim()?.match(/\$[\d,]+(?:\.\d{2})?/)?.[0];
    if (!price) { const m=document.body.innerText.match(/\$[\d,]+(?:\.\d{2})?/); if(m)price=m[0]; }
    const metaDesc = document.querySelector('meta[name=description]')?.content?.trim();
    return { name, price, metaDesc };
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  await log('=== West Elm catalogue scraper (bestsellers strategy) ===');

  let existing = [];
  if (RESUME && existsSync(OUT_PATH)) {
    existing = JSON.parse(await readFile(OUT_PATH,'utf8')).products || [];
    await log(`Resuming — ${existing.length} existing products`);
  }
  const seenSlugs = new Set(existing.map(p=>p.slug));

  const browser = await puppeteer.launch({ headless:'new', args:['--no-sandbox','--disable-setuid-sandbox'] });
  let page = await browser.newPage();
  await page.setUserAgent(UA);

  async function resetPage() {
    try { await page.close(); } catch {}
    page = await browser.newPage();
    await page.setUserAgent(UA);
  }

  let products = [...existing];
  let newCount=0, errorCount=0;

  try {
    // Step 1: get bestsellers slug list
    const rawText = await fetchBestsellers(page);
    const allSlugs = rawText.split('\n').map(s=>s.trim()).filter(s=>s && s !== 'groupId');

    // Step 2: classify slugs into buckets
    const buckets = {}; // key: "room|cat"
    for (const slug of allSlugs) {
      const cat = classifySlug(slug);
      if (!cat) continue;
      const key = `${cat.room}|${cat.cat}`;
      if (!buckets[key]) buckets[key] = { ...cat, slugs: [] };
      if (buckets[key].slugs.length < MAX_PER_CAT) buckets[key].slugs.push(slug);
    }

    const totalBuckets = Object.keys(buckets).length;
    await log(`Classified into ${totalBuckets} categories`);
    for (const [k,b] of Object.entries(buckets)) {
      await log(`  ${k}: ${b.slugs.length} slugs`);
    }

    // Desired categories only
    const WANTED = [
      'living room|sofa','living room|armchair','living room|coffee table',
      'living room|side table','living room|tv unit','living room|shelving','living room|rug',
      'bedroom|bed','bedroom|nightstand','bedroom|dresser','bedroom|bench',
      'dining room|dining table','dining room|dining chair','dining room|sideboard','dining room|barstool',
      'other|desk',
    ];

    // Step 3: scrape each product
    for (const key of WANTED) {
      const bucket = buckets[key];
      if (!bucket) { await log(`\n── SKIP (no slugs): ${key}`); continue; }

      await log(`\n── ${bucket.room.toUpperCase()} / ${bucket.cat} (${bucket.slugs.length} slugs) ──────────────`);

      for (const slug of bucket.slugs) {
        if (seenSlugs.has(slug)) { await log(`  → skip: ${slug}`); continue; }

        await log(`  Scraping: ${slug}`);
        await delay(1000);

        try {
          const pipData = await fetchProductData(page, slug);
          const { name, price, metaDesc } = await getNameAndPrice(page, slug);
          const desc = pipData.description || metaDesc || null;
          const [wIn,dIn,hIn] = pipData.dimsIn || [null,null,null];
          const hay = ((name||'')+(desc||'')).toLowerCase();
          const style = /mid-century|mid century/.test(hay)?'mid-century'
                      : /scandinavian/.test(hay)?'scandinavian'
                      : /industrial/.test(hay)?'industrial'
                      : /traditional/.test(hay)?'traditional'
                      : /modern|contemporary/.test(hay)?'modern':'other';

          const product = {
            id: slugify(name||slug), slug, name:name||slug, price,
            category: bucket.cat, room: bucket.room, style,
            colors: pipData.colors, sizes: pipData.sizes,
            dimensions: wIn ? {
              widthIn:wIn, depthIn:dIn, heightIn:hIn,
              width:inchesToMetres(wIn), depth:inchesToMetres(dIn), height:inchesToMetres(hIn), unit:'m',
            } : null,
            imageUrls: pipData.imageUrls,
            productUrl: `https://www.westelm.com/products/${slug}/`,
            source: 'west-elm', description: desc, scrapedAt: new Date().toISOString(),
          };

          products.push(product); seenSlugs.add(slug); newCount++;
          const dims = wIn?`${wIn}"W × ${dIn}"D × ${hIn}"H`:'dims n/a';
          await log(`  ✓ ${product.name} | ${product.price||'—'} | ${dims} | ${product.imageUrls.length} imgs`);

          await writeFile(OUT_PATH, JSON.stringify({
            version:'1.0', source:'west-elm', builtAt:new Date().toISOString(), total:products.length, products
          },null,2));

        } catch(err) {
          await log(`  ✗ ${slug}: ${err.message}`);
          if (/detached/i.test(err.message)) await resetPage();
          errorCount++;
        }
      }
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

main().catch(err=>{ console.error('Fatal:',err); process.exit(1); });
