#!/usr/bin/env node
/**
 * CoStage — manual library builder
 *
 * For pieces you can't scrape (RH, bot-blocked sites, etc.): drop the product
 * photos, a fabric/color swatch screenshot, and the pasted product text into a
 * folder, point this script at it, and it runs the same 4-stage asset pipeline
 * used by libraryBuilder.html and appends the result straight to
 * costage-library.json — no manual UI clicking.
 *
 * Folder layout (one per item):
 *
 *   my-items/sven-sofa/
 *     details.txt      — paste the product name, price, dimensions, materials,
 *                         description, color/fabric options — whatever you
 *                         copied off the page. One blob of text is fine.
 *     swatch.png       — (optional) screenshot of the fabric/color picker
 *     images/
 *       1.jpg
 *       2.jpg          — product photos (front/angle shots from the listing)
 *
 * Usage:
 *   node buildLibraryItem.mjs my-items/sven-sofa        # single item
 *   node buildLibraryItem.mjs my-items                  # batch — every
 *                                                         subfolder with a
 *                                                         details.txt
 *   node buildLibraryItem.mjs my-items/sven-sofa --live # use real API keys
 *                                                         (NANOBANANA_KEY,
 *                                                         OPENAI_KEY, FAL_KEY
 *                                                         env vars) instead
 *                                                         of mock mode
 */

import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as pipeline from './assetPipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIBRARY_PATH = path.join(__dirname, 'costage-library.json');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

// ── Heuristic text parsing (same idea as the backend's free extractor, just
// pointed at a pasted text blob instead of scraped HTML) ────────────────────

const CATEGORY_KEYWORDS = [
  ['sectional', 'sofa'], ['sofa', 'sofa'], ['loveseat', 'sofa'],
  ['armchair', 'armchair'], ['accent chair', 'armchair'], ['lounge chair', 'armchair'],
  ['coffee table', 'coffee table'], ['side table', 'coffee table'],
  ['dining table', 'dining table'], ['dining chair', 'dining chair'],
  ['bed frame', 'bed'], ['bed', 'bed'], ['nightstand', 'nightstand'],
  ['dresser', 'dresser'], ['chest of drawers', 'dresser'], ['desk', 'desk'],
  ['bookshelf', 'bookshelf'], ['bookcase', 'bookshelf'],
  ['tv stand', 'tv unit'], ['media console', 'tv unit'],
  ['rug', 'rug'], ['lamp', 'lamp'],
];

const STYLE_KEYWORDS = [
  ['mid-century', 'mid-century'], ['mid century', 'mid-century'],
  ['scandinavian', 'scandinavian'], ['industrial', 'industrial'],
  ['traditional', 'traditional'], ['transitional', 'transitional'],
  ['contemporary', 'modern'], ['modern', 'modern'],
];

const MATERIAL_KEYWORDS = [
  'leather', 'linen', 'velvet', 'cotton', 'wool', 'boucle', 'bouclé', 'chenille',
  'oak', 'walnut', 'pine', 'maple', 'mahogany', 'teak', 'reclaimed wood',
  'metal', 'steel', 'iron', 'brass', 'aluminum', 'glass', 'marble', 'stone',
  'rattan', 'wicker', 'cane', 'concrete', 'ceramic',
];

// Rough realistic footprints per category, in metres [width, depth, height] —
// used as a fallback when no dimensions could be parsed from the pasted text.
const CATEGORY_DIMENSIONS = {
  'sofa': [2.10, 0.95, 0.85], 'armchair': [0.85, 0.90, 0.85],
  'coffee table': [1.20, 0.65, 0.40], 'dining table': [1.80, 0.90, 0.75],
  'dining chair': [0.50, 0.55, 0.85], 'bed': [1.60, 2.10, 1.10],
  'nightstand': [0.50, 0.40, 0.60], 'dresser': [1.40, 0.50, 0.85],
  'desk': [1.30, 0.65, 0.75], 'bookshelf': [0.90, 0.35, 1.85],
  'tv unit': [1.60, 0.45, 0.50], 'rug': [2.40, 1.70, 0.02],
  'lamp': [0.35, 0.35, 1.55], 'other': [1.00, 0.80, 0.80],
};

function guessFromKeywords(text, table, fallback) {
  const lower = text.toLowerCase();
  for (const [needle, value] of table) if (lower.includes(needle)) return value;
  return fallback;
}

function slugify(text, fallback) {
  const slug = (text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  return slug || fallback;
}

function parsePrice(text) {
  const m = text.match(/[$£€]\s?([\d,]+(?:\.\d{2})?)/);
  if (!m) return { price: null, currency: 'USD' };
  const currency = m[0].includes('£') ? 'GBP' : m[0].includes('€') ? 'EUR' : 'USD';
  const symbol = currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : '$';
  return { price: `${symbol}${m[1]}`, currency };
}

// Parses "83.5"W x 38"D x 35"H", "212 x 97 x 89 cm", "2.1m x 0.95m x 0.85m", etc.
// Returns metres, since that's what the pipeline prompts/scale-hints expect.
function parseDimensions(text) {
  const m = text.match(
    /(\d+(?:\.\d+)?)\s*(?:["']|in\b|cm\b|m\b)?\s*(?:w(?:ide)?)?\s*[x×]\s*(\d+(?:\.\d+)?)\s*(?:["']|in\b|cm\b|m\b)?\s*(?:d(?:eep)?)?\s*[x×]\s*(\d+(?:\.\d+)?)\s*(["']|in(?:ches)?|cm|m)?\s*(?:h(?:igh|all)?)?/i
  );
  if (!m) return null;

  const unitHint = (m[4] || '').toLowerCase();
  const context = text.slice(Math.max(0, m.index - 5), m.index + m[0].length + 10).toLowerCase();
  let toMetres;
  if (unitHint === 'cm' || context.includes('cm')) toMetres = (n) => n * 0.01;
  else if (unitHint === 'm' && !context.includes('cm') && !context.includes('mm')) toMetres = (n) => n;
  else toMetres = (n) => n * 0.0254; // default: inches — most US retailer copy uses "W x D x H

  const [w, d, h] = [m[1], m[2], m[3]].map(n => Math.round(toMetres(parseFloat(n)) * 100) / 100);
  return { width: w, depth: d, height: h, unit: 'm' };
}

function parseColors(text) {
  const m = text.match(/colou?rs?(?:\/options?| options?)?\s*[:\-]\s*([^\n]+)/i)
        || text.match(/(?:available in|comes in)\s*[:\-]?\s*([^\n.]+)/i);
  if (!m) return [];
  return m[1].split(/[,/]/).map(s => s.trim().toLowerCase()).filter(Boolean).slice(0, 8);
}

function parseDetails(raw, fallbackName) {
  const text = raw.replace(/\r\n/g, '\n').trim();
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const name = lines[0] || fallbackName;

  const { price, currency } = parsePrice(text);
  const dims = parseDimensions(text);
  const haystack = text.toLowerCase();
  const category = guessFromKeywords(haystack, CATEGORY_KEYWORDS, 'other');
  const style = guessFromKeywords(haystack, STYLE_KEYWORDS, 'other');
  const materials = MATERIAL_KEYWORDS.filter(k => haystack.includes(k));
  const colors = parseColors(text);

  const [w, d, h] = dims ? [dims.width, dims.depth, dims.height] : (CATEGORY_DIMENSIONS[category] || CATEGORY_DIMENSIONS.other);

  // Description: everything after the first line, trimmed to a sane length.
  const description = lines.slice(1).join(' ').replace(/\s+/g, ' ').slice(0, 1000) || null;

  return {
    name,
    price, currency,
    dimensions: { width: w, depth: d, height: h, unit: 'm' },
    dimensionsGuessed: !dims,
    category, style, materials, colors,
    description,
  };
}

// ── Local file serving (the pipeline fetches images by URL — this gives your
// local files a URL for the duration of the run) ────────────────────────────

function startStaticServer(rootDir) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
      const full = path.join(rootDir, rel);
      if (!full.startsWith(rootDir) || !existsSync(full)) { res.writeHead(404); return res.end(); }
      const ext = path.extname(full).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      createReadStream(full).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ baseUrl: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

// ── Folder → product ─────────────────────────────────────────────────────────

async function findImages(dir) {
  const imagesDir = path.join(dir, 'images');
  const scanDir = existsSync(imagesDir) ? imagesDir : dir;
  const entries = await readdir(scanDir);
  const files = entries
    .filter(f => IMAGE_EXT.has(path.extname(f).toLowerCase()) && !/^swatch/i.test(f))
    .sort();
  const relDir = scanDir === imagesDir ? 'images' : '.';
  return files.map(f => path.join(relDir, f).replace(/\\/g, '/'));
}

async function findSwatch(dir) {
  const entries = await readdir(dir);
  const match = entries.find(f => /^swatch/i.test(f) && IMAGE_EXT.has(path.extname(f).toLowerCase()));
  return match || null;
}

async function buildProductFromFolder(dir, baseUrl) {
  const detailsPath = path.join(dir, 'details.txt');
  if (!existsSync(detailsPath)) throw new Error(`No details.txt in ${dir}`);

  const folderName = path.basename(dir);
  const raw = await readFile(detailsPath, 'utf8');
  const parsed = parseDetails(raw, folderName.replace(/-/g, ' '));

  const imageRelPaths = await findImages(dir);
  if (!imageRelPaths.length) throw new Error(`No product images found in ${dir} (looked in ./images/ and ./)`);
  const imageUrls = imageRelPaths.map(p => `${baseUrl}/${encodeURI(p)}`);

  const swatchFile = await findSwatch(dir);
  const swatchUrl = swatchFile ? `${baseUrl}/${encodeURI(swatchFile)}` : null;

  const id = slugify(parsed.name, folderName);

  return {
    id,
    name: parsed.name,
    price: parsed.price,
    currency: parsed.currency,
    dimensions: parsed.dimensions,
    category: parsed.category,
    style: parsed.style,
    materials: parsed.materials,
    colors: parsed.colors,
    imageUrls,
    swatchUrl,
    productUrl: null,
    source: 'manual',
    description: parsed.description,
    sku: null,
    glbReady: false,
    _dimensionsGuessed: parsed.dimensionsGuessed,
  };
}

// ── Library persistence ──────────────────────────────────────────────────────

async function loadLibraryFile() {
  if (!existsSync(LIBRARY_PATH)) return { version: '1.0', exportedAt: new Date().toISOString(), assetCount: 0, assets: [] };
  return JSON.parse(await readFile(LIBRARY_PATH, 'utf8'));
}

async function appendToLibrary(product, result) {
  const { writeFile } = await import('node:fs/promises');
  const lib = await loadLibraryFile();
  if (lib.assets.find(a => a.id === product.id)) {
    console.log(`  ⚠ "${product.id}" already in costage-library.json — skipping append`);
    return;
  }
  lib.assets.push({
    id: product.id, name: product.name, category: product.category, style: product.style,
    materials: product.materials, colors: product.colors, dimensions: product.dimensions,
    price: product.price, sourceUrl: product.productUrl, source: product.source,
    imageUrls: product.imageUrls, swatchUrl: product.swatchUrl,
    cleanPlateUrl: result.cleanPlateUrl, angleUrls: result.angleUrls,
    glbUrl: result.glbUrl, previewUrl: result.previewUrl,
    addedAt: new Date().toISOString(),
  });
  lib.assetCount = lib.assets.length;
  lib.exportedAt = new Date().toISOString();
  await writeFile(LIBRARY_PATH, JSON.stringify(lib, null, 2));
  console.log(`  ✓ Appended to costage-library.json (${lib.assets.length} assets total)`);
}

// ── Run ──────────────────────────────────────────────────────────────────────

async function runForFolder(dir, { mock }) {
  const name = path.basename(dir);
  console.log(`\n── ${name} ──────────────────────────────`);

  const { baseUrl, close } = await startStaticServer(dir);
  try {
    const product = await buildProductFromFolder(dir, baseUrl);
    console.log(`  Parsed: "${product.name}" · ${product.price || 'price n/a'} · ${product.category}/${product.style}`);
    console.log(`  Dimensions: ${product.dimensions.width}×${product.dimensions.depth}×${product.dimensions.height}m${product._dimensionsGuessed ? '  (guessed from category — couldn\'t parse from text, double check this)' : ''}`);
    console.log(`  Materials: ${product.materials.join(', ') || '—'} · Colors: ${product.colors.join(', ') || '—'}`);
    console.log(`  Images: ${product.imageUrls.length}${product.swatchUrl ? ' + swatch' : ''}`);

    let lastPct = -1;
    const result = await pipeline.runPipeline(product, (stage, label, pct) => {
      if (pct != null && pct !== lastPct) { lastPct = pct; console.log(`  [${String(pct).padStart(3)}%] ${stage}: ${label}`); }
      else if (pct == null) { console.log(`         ${stage}: ${label}`); }
    });

    if (result.error) { console.error(`  ✗ Pipeline failed: ${result.error}`); return false; }

    console.log(`  ✓ GLB: ${result.glbUrl}`);
    await appendToLibrary(product, result);
    return true;
  } catch (err) {
    console.error(`  ✗ ${err.message}`);
    return false;
  } finally {
    close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const live = args.includes('--live');
  const target = args.find(a => !a.startsWith('--'));

  if (!target) {
    console.log('Usage: node buildLibraryItem.mjs <folder> [--live]');
    console.log('  <folder>  either a single item folder (contains details.txt)');
    console.log('            or a parent folder of several item folders');
    console.log('  --live    use real API keys instead of mock mode');
    process.exit(1);
  }

  const root = path.resolve(target);
  if (!existsSync(root)) { console.error(`Not found: ${root}`); process.exit(1); }

  pipeline.init({
    mock: !live,
    nanoBananaKey: process.env.NANOBANANA_KEY || '',
    openaiKey:     process.env.OPENAI_KEY || '',
    falKey:        process.env.FAL_KEY || '',
  });
  console.log(`Mode: ${live ? 'LIVE (real API calls — billed)' : 'MOCK (no API calls, placeholder images)'}`);
  if (live && (!process.env.NANOBANANA_KEY || !process.env.OPENAI_KEY || !process.env.FAL_KEY)) {
    console.log('⚠ --live but one or more of NANOBANANA_KEY / OPENAI_KEY / FAL_KEY env vars is missing — calls to that stage will fail.');
  }

  // Single item: the folder itself has details.txt. Batch: subfolders do.
  let folders;
  if (existsSync(path.join(root, 'details.txt'))) {
    folders = [root];
  } else {
    const entries = await readdir(root, { withFileTypes: true });
    folders = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const sub = path.join(root, e.name);
      if (existsSync(path.join(sub, 'details.txt'))) folders.push(sub);
    }
    if (!folders.length) {
      console.error(`No details.txt found in ${root} or its subfolders.`);
      process.exit(1);
    }
    console.log(`Batch mode — found ${folders.length} item folder(s).`);
  }

  let ok = 0;
  for (const dir of folders) {
    if (await runForFolder(dir, { mock: !live })) ok++;
  }
  console.log(`\nDone — ${ok}/${folders.length} item(s) built and saved to costage-library.json`);
}

main();
