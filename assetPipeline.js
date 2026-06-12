/**
 * CoStage Asset Pipeline
 *
 * Turns a raw furniture product (name, dimensions, scraped image URLs) into
 * a production-ready library asset via a four-stage process:
 *
 *   Stage 1 — Clean plate      : nano-banana image-to-image
 *                                 Strips background/lifestyle staging from retailer photo.
 *                                 Outputs isolated furniture on neutral ground.
 *
 *   Stage 2 — Multi-angle gen  : gpt-image-2 (OpenAI images/edit)
 *                                 Uses clean plate + product metadata to synthesise
 *                                 front, side-45°, side-90°, and rear views.
 *                                 Gives Hunyuan 4 consistent angles instead of 1.
 *
 *   Stage 3 — 3D reconstruction: Hunyuan 3D v2 via FAL
 *                                 All 4 angles → textured GLB with PBR materials.
 *                                 Configurable face count and generate type.
 *
 *   Stage 4 — Preview render   : nano-banana image-to-image
 *                                 Polishes the auto-render into a styled studio card
 *                                 for the library thumbnail (neutral bg, soft shadow,
 *                                 consistent framing across all assets).
 *
 * Each stage fires a progress callback so the UI can show per-step status.
 * All API calls are real; swap the mock flag to false in production.
 */

// ── Config ──────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  mock: true,   // ← set false in production once you have API keys

  nanoBanana: {
    endpoint: 'https://api.nanobananaapi.dev/v1/images/edit',
    model:    'gemini-3-pro-image-preview',
    apiKey:   '',   // set via init()
  },

  openai: {
    endpoint: 'https://api.openai.com/v1/images/edits',
    model:    'gpt-image-2',
    apiKey:   '',   // set via init()
  },

  fal: {
    endpoint: 'https://fal.run/fal-ai/hunyuan3d-2',
    apiKey:   '',   // set via init()
    faceCount:     50000,
    enablePbr:     true,
    generateType:  'Normal',   // Normal | LowPoly | Geometry
    polygonType:   'triangle',
  },
};

let _config = { ...DEFAULT_CONFIG };

/**
 * Initialise the pipeline with API keys.
 * Call this once before running any pipeline.
 *
 * @param {{ nanoBananaKey?: string, openaiKey?: string, falKey?: string, mock?: boolean }} opts
 */
export function init(opts = {}) {
  if (opts.nanoBananaKey) _config.nanoBanana.apiKey = opts.nanoBananaKey;
  if (opts.openaiKey)     _config.openai.apiKey     = opts.openaiKey;
  if (opts.falKey)        _config.fal.apiKey        = opts.falKey;
  if (opts.mock !== undefined) _config.mock = opts.mock;
}

// ── Main pipeline ────────────────────────────────────────────────────────────

/**
 * Run the full four-stage pipeline for a single furniture product.
 *
 * @param {Object} product   - product record from the library builder
 * @param {Function} onProgress - (stage, stepLabel, pct) => void
 * @returns {Promise<PipelineResult>}
 */
export async function runPipeline(product, onProgress = () => {}) {

  const result = {
    productId:    product.id,
    cleanPlateUrl: null,
    angleUrls:    [],
    glbUrl:       null,
    previewUrl:   null,
    metadata:     buildMetadata(product),
    stages:       {},
    error:        null,
  };

  try {
    // ── Stage 1: Clean plate ─────────────────────────────────────────────
    onProgress('clean', 'Removing background & lifestyle staging…', 10);
    const sourceUrl = product.imageUrls?.[0];
    if (!sourceUrl) throw new Error('No source image URL for ' + product.name);

    result.cleanPlateUrl = await stage_cleanPlate(sourceUrl, product, onProgress);
    result.stages.clean  = { status: 'done', url: result.cleanPlateUrl };
    onProgress('clean', 'Clean plate ready', 25);

    // ── Stage 2: Multi-angle generation ─────────────────────────────────
    onProgress('angles', 'Generating front, side & rear reference angles…', 30);
    result.angleUrls     = await stage_multiAngle(result.cleanPlateUrl, product, onProgress);
    result.stages.angles = { status: 'done', urls: result.angleUrls };
    onProgress('angles', `${result.angleUrls.length} angle images ready`, 55);

    // ── Stage 3: 3D reconstruction ───────────────────────────────────────
    onProgress('glb', 'Sending angles to Hunyuan 3D (FAL)…', 60);
    result.glbUrl      = await stage_hunyuan3D(result.angleUrls, product, onProgress);
    result.stages.glb  = { status: 'done', url: result.glbUrl };
    onProgress('glb', 'GLB asset generated', 80);

    // ── Stage 4: Preview render ──────────────────────────────────────────
    onProgress('preview', 'Generating styled library preview…', 85);
    result.previewUrl      = await stage_previewRender(result.glbUrl, result.angleUrls, product, onProgress);
    result.stages.preview  = { status: 'done', url: result.previewUrl };
    onProgress('preview', 'Preview image ready', 100);

  } catch (err) {
    result.error = err.message;
    console.error('[AssetPipeline] Error for', product.id, err);
  }

  return result;
}

// ── Stage implementations ────────────────────────────────────────────────────

/**
 * Stage 1 — Clean plate via nano-banana image-to-image
 *
 * Takes the raw retailer product image (often has lifestyle props, other furniture,
 * or a room background) and returns an isolated top-down or 3/4 front view of the
 * furniture piece on a clean neutral surface.
 */
async function stage_cleanPlate(sourceImageUrl, product, onProgress) {
  const prompt = buildCleanPlatePrompt(product);

  if (_config.mock) {
    await simulateDelay(1200);
    return mockImageUrl(product.id, 'clean');
  }

  const response = await fetch(_config.nanoBanana.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${_config.nanoBanana.apiKey}`,
    },
    body: JSON.stringify({
      model:      _config.nanoBanana.model,
      image:      sourceImageUrl,
      prompt,
      num:        1,
      image_size: '1:1',
    }),
  });

  const data = await response.json();
  if (data.code !== 0) throw new Error(`nano-banana clean plate failed: ${data.message}`);

  return Array.isArray(data.data?.url) ? data.data.url[0] : data.data?.url;
}

/**
 * Stage 2 — Multi-angle synthesis via GPT-Image-2
 *
 * Uses the clean plate as a reference image and prompts gpt-image-2 to generate
 * front, side-45°, side-90°, and rear views. These give Hunyuan consistent geometry
 * information from all sides, dramatically improving GLB quality vs single-image input.
 *
 * Returns array of 4 image URLs: [front, side45, side90, rear]
 */
async function stage_multiAngle(cleanPlateUrl, product, onProgress) {
  const angles = [
    { label: 'front',   prompt: buildAnglePrompt(product, 'front',        '0°')   },
    { label: 'side-45', prompt: buildAnglePrompt(product, 'side-45',      '45°')  },
    { label: 'side-90', prompt: buildAnglePrompt(product, 'side-90',      '90°')  },
    { label: 'rear',    prompt: buildAnglePrompt(product, 'rear',         '180°') },
  ];

  if (_config.mock) {
    await simulateDelay(2000);
    return angles.map((a, i) => mockImageUrl(product.id, a.label));
  }

  // Fetch the clean plate as a Blob for the OpenAI multipart form
  const cleanBlob = await fetchImageBlob(cleanPlateUrl);

  const angleUrls = [];
  for (const angle of angles) {
    onProgress('angles', `Generating ${angle.label} view…`, null);

    const form = new FormData();
    form.append('model',  _config.openai.model);
    form.append('prompt', angle.prompt);
    form.append('image',  cleanBlob, 'reference.png');
    form.append('n',      '1');
    form.append('size',   '1024x1024');

    const resp = await fetch(_config.openai.endpoint, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${_config.openai.apiKey}` },
      body:    form,
    });

    const data = await resp.json();
    if (data.error) throw new Error(`gpt-image-2 angle "${angle.label}" failed: ${data.error.message}`);
    angleUrls.push(data.data[0].url);
  }

  return angleUrls;
}

/**
 * Stage 3 — 3D reconstruction via Hunyuan 3D v2 on FAL
 *
 * Sends all 4 angle images to Hunyuan 3D. The multi-view input gives the model
 * enough geometric information to reconstruct occluded surfaces (e.g. the back of a
 * sofa, underside of a table) that are invisible in any single photo.
 *
 * Returns a GLB URL.
 */
async function stage_hunyuan3D(angleUrls, product, onProgress) {
  if (_config.mock) {
    await simulateDelay(3500);
    return `mock://glb/${product.id}_${Date.now()}.glb`;
  }

  const cfg = _config.fal;

  // FAL Hunyuan 3D v2 accepts multi-view via image_urls array
  const response = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Key ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      image_urls:    angleUrls,
      face_count:    cfg.faceCount,
      enable_pbr:    cfg.enablePbr,
      generate_type: cfg.generateType,
      polygon_type:  cfg.polygonType,
      // Pass real-world scale hint from product dimensions
      scale_hint: product.dimensions
        ? Math.max(product.dimensions.width, product.dimensions.depth, product.dimensions.height)
        : 1.0,
    }),
  });

  const data = await response.json();
  if (data.error) throw new Error(`FAL Hunyuan 3D failed: ${JSON.stringify(data.error)}`);

  return data.model_mesh?.url || data.output?.url;
}

/**
 * Stage 4 — Preview render polish via nano-banana
 *
 * Hunyuan auto-renders produce a raw turntable frame. This stage uses nano-banana
 * to produce a consistent, styled library card:
 *  - Neutral warm-grey background
 *  - Soft directional shadow
 *  - Consistent 3/4 front-left camera angle
 *  - CoStage colour grading (slightly warm, high contrast whites)
 *
 * If no GLB render is available yet (mock mode), uses the best angle image.
 */
async function stage_previewRender(glbUrl, angleUrls, product, onProgress) {
  // Use the front angle image as render source (or GLB thumbnail in production)
  const sourceUrl = angleUrls[0] || mockImageUrl(product.id, 'front');
  const prompt = buildPreviewPrompt(product);

  if (_config.mock) {
    await simulateDelay(1000);
    return mockImageUrl(product.id, 'preview');
  }

  const response = await fetch(_config.nanoBanana.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${_config.nanoBanana.apiKey}`,
    },
    body: JSON.stringify({
      model:      _config.nanoBanana.model,
      image:      sourceUrl,
      prompt,
      num:        1,
      image_size: '1:1',
    }),
  });

  const data = await response.json();
  if (data.code !== 0) throw new Error(`nano-banana preview render failed: ${data.message}`);

  return Array.isArray(data.data?.url) ? data.data.url[0] : data.data?.url;
}

// ── Prompt builders ──────────────────────────────────────────────────────────

function buildCleanPlatePrompt(product) {
  const { name, category, style, materials, dimensions } = product;
  const mat  = (materials || []).join(' and ');
  const dims = dimensions
    ? `${dimensions.width}m wide × ${dimensions.depth}m deep × ${dimensions.height}m tall`
    : '';

  return [
    `Isolate this ${style || ''} ${category} furniture piece on a clean neutral white/light grey background.`,
    `The furniture is: ${name}.`,
    mat   ? `Materials: ${mat}.` : '',
    dims  ? `Real-world dimensions: ${dims}.` : '',
    'Remove all lifestyle props, plants, books, decorative objects, room background, and other furniture.',
    'Keep only the single furniture item. Maintain photorealistic quality, accurate proportions, and natural lighting.',
    'View: slight 3/4 angle from front-left, showing full piece. Soft neutral studio lighting. No harsh shadows.',
    'Output: clean product photography style on neutral background, suitable as 3D reconstruction reference.',
  ].filter(Boolean).join(' ');
}

function buildAnglePrompt(product, angle, degrees) {
  const { name, category, style, materials, dimensions } = product;
  const mat  = (materials || []).join(' and ');
  const dims = dimensions
    ? `${dimensions.width}m wide × ${dimensions.depth}m deep × ${dimensions.height}m tall`
    : '';

  const angleDescriptions = {
    'front':   'Straight-on front view, camera at eye level facing the front face directly.',
    'side-45': '3/4 front-left view, camera at 45 degrees from the front-left corner.',
    'side-90': 'Direct side view at 90 degrees, showing the full side profile.',
    'rear':    'Rear view at 180 degrees, showing the back of the piece.',
  };

  return [
    `Product photography of a ${style || ''} ${category}: ${name}.`,
    mat  ? `Materials: ${mat}.` : '',
    dims ? `Dimensions: ${dims}.` : '',
    'Clean neutral white/light grey background. No other props or objects.',
    angleDescriptions[angle] || `View at ${degrees}.`,
    'Consistent studio lighting — soft, directional from top-left. Subtle floor shadow.',
    'Photorealistic. Match exact proportions and materials shown in the reference image.',
    'This is a multi-view reference image for 3D reconstruction — geometric accuracy is critical.',
  ].filter(Boolean).join(' ');
}

function buildPreviewPrompt(product) {
  const { name, category, style } = product;
  return [
    `Reframe and polish this ${category} product image for a professional furniture library card.`,
    `Piece: ${name}.`,
    'Apply: warm neutral studio background (#f5f3ef), soft directional shadow underneath,',
    '3/4 front-left camera angle showing full piece with breathing room on all sides.',
    'Subtle warm colour grade — slightly elevated whites, natural material tones.',
    'Remove any remaining background elements. Output: square 1:1, clean studio product shot.',
    'This is a library thumbnail — the piece should be centred, well-lit, and immediately identifiable.',
  ].join(' ');
}

function buildMetadata(product) {
  return {
    name:        product.name,
    category:    product.category,
    style:       product.style,
    materials:   product.materials || [],
    dimensions:  product.dimensions,
    price:       product.price,
    sourceUrl:   product.productUrl,
    source:      product.source,
    pipeline:    'nano-banana:clean → gpt-image-2:multiangle → hunyuan3d:glb → nano-banana:preview',
    generatedAt: new Date().toISOString(),
  };
}

// ── Utilities ────────────────────────────────────────────────────────────────

async function fetchImageBlob(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch image: ${url}`);
  return response.blob();
}

async function simulateDelay(ms) {
  return new Promise(r => setTimeout(r, ms + Math.random() * ms * 0.3));
}

function mockImageUrl(productId, stage) {
  // Returns a deterministic picsum URL so the UI has real images to display
  const seed = `${productId}-${stage}`.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  const imgs = {
    clean:   `https://picsum.photos/seed/${seed}/600/600`,
    front:   `https://picsum.photos/seed/${seed+1}/600/600`,
    'side-45': `https://picsum.photos/seed/${seed+2}/600/600`,
    'side-90': `https://picsum.photos/seed/${seed+3}/600/600`,
    rear:    `https://picsum.photos/seed/${seed+4}/600/600`,
    preview: `https://picsum.photos/seed/${seed+5}/600/600`,
  };
  return imgs[stage] || `https://picsum.photos/seed/${seed}/600/600`;
}

// ── Batch runner ─────────────────────────────────────────────────────────────

/**
 * Run the pipeline for multiple products with concurrency control.
 *
 * @param {Object[]} products
 * @param {Function} onProductProgress - (productId, stage, label, pct) => void
 * @param {number}   concurrency - max parallel pipelines (default 2)
 * @returns {Promise<PipelineResult[]>}
 */
export async function runBatch(products, onProductProgress = () => {}, concurrency = 2) {
  const results = [];
  const queue   = [...products];
  const running = new Set();

  return new Promise((resolve) => {
    function startNext() {
      while (running.size < concurrency && queue.length > 0) {
        const product = queue.shift();
        running.add(product.id);

        runPipeline(product, (stage, label, pct) => {
          onProductProgress(product.id, stage, label, pct);
        }).then(result => {
          results.push(result);
          running.delete(product.id);
          if (queue.length === 0 && running.size === 0) resolve(results);
          else startNext();
        });
      }
    }
    startNext();
  });
}

/**
 * @typedef {Object} PipelineResult
 * @property {string}   productId
 * @property {string|null} cleanPlateUrl
 * @property {string[]} angleUrls       - [front, side45, side90, rear]
 * @property {string|null} glbUrl
 * @property {string|null} previewUrl
 * @property {Object}   metadata
 * @property {Object}   stages          - per-stage status
 * @property {string|null} error
 */
