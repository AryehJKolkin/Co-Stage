// Proxies CoStage's staging requests to an AI image-edit model so API keys
// live only in environment variables (set in the Vercel dashboard, or in
// .env for local `vercel dev`) — they never reach the browser. Tries
// OpenAI's gpt-image-1 first, then falls back to Gemini's image model
// ("nano banana") if OpenAI is unavailable or errors.

export const config = { runtime: 'edge' };

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/images/edits';
const OPENAI_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const OPENAI_QUALITY = process.env.OPENAI_IMAGE_QUALITY || 'medium';

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3-pro-image-preview';

// Best-effort per-instance rate limit. Resets on cold start and isn't shared
// across instances — it's defense-in-depth against a runaway loop or casual
// abuse, not a substitute for the key's own spending limits. Kept low because
// each gpt-image-1 edit call has real cost.
const RATE_LIMIT = 5;           // requests
const RATE_WINDOW_MS = 60_000;  // per minute, per IP
const requestLog = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const hits = (requestLog.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  hits.push(now);
  requestLog.set(ip, hits);
  return hits.length > RATE_LIMIT;
}

// Only allow calls that came from CoStage's own site (or local `vercel dev`).
// Blocks other sites/scripts from riding on this function with our API key.
function isAllowedOrigin(req) {
  // Vercel sets these to the deployment's hostnames (no protocol, e.g. "my-app.vercel.app")
  const allowedHosts = [process.env.VERCEL_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL].filter(Boolean);
  const origin = req.headers.get('origin') || req.headers.get('referer');
  if (!allowedHosts.length || !origin) return true; // can't verify — fail open rather than break local dev
  if (origin.startsWith('http://localhost')) return true;
  return allowedHosts.some(host => origin.includes(host));
}

// Accepts either a data URL (from an uploaded file) or an http(s) URL (e.g.
// a furniture catalogue reference photo) and returns a Blob for the OpenAI
// edit request's multipart form.
async function toBlob(src) {
  const dataUrlMatch = src.match(/^data:([^;]+);base64,(.*)$/s);
  if (dataUrlMatch) {
    const [, mimeType, base64] = dataUrlMatch;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mimeType });
  }
  const res = await fetch(src);
  if (!res.ok) throw new Error(`Failed to fetch reference image (${res.status})`);
  return await res.blob();
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Accepts either a data URL or an http(s) URL and returns Gemini's inlineData shape.
async function toInlineData(src) {
  const dataUrlMatch = src.match(/^data:([^;]+);base64,(.*)$/s);
  if (dataUrlMatch) {
    return { mimeType: dataUrlMatch[1], data: dataUrlMatch[2] };
  }
  const res = await fetch(src);
  if (!res.ok) throw new Error(`Failed to fetch reference image (${res.status})`);
  const mimeType = res.headers.get('content-type') || 'image/jpeg';
  const data = arrayBufferToBase64(await res.arrayBuffer());
  return { mimeType, data };
}

async function stageWithOpenAI(imageList, prompt) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set');

  const form = new FormData();
  form.append('model', OPENAI_MODEL);
  form.append('prompt', prompt);
  form.append('quality', OPENAI_QUALITY);
  form.append('size', 'auto');
  for (let i = 0; i < imageList.length; i++) {
    form.append('image[]', await toBlob(imageList[i]), `image${i}.png`);
  }

  const res = await fetch(OPENAI_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `OpenAI API error (${res.status})`);

  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI returned no image');
  return `data:image/png;base64,${b64}`;
}

async function stageWithGemini(imageList, prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');

  const inlineParts = await Promise.all(imageList.map(async img => ({ inlineData: await toInlineData(img) })));
  const parts = [...inlineParts, { text: prompt }];

  const res = await fetch(`${GEMINI_ENDPOINT}/${GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': key,
    },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Gemini API error (${res.status})`);

  const responseParts = data.candidates?.[0]?.content?.parts || [];
  const imagePart = responseParts.find(p => p.inlineData);
  if (!imagePart) throw new Error('Gemini returned no image');
  return `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`;
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!isAllowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
  if (isRateLimited(ip)) {
    return new Response(JSON.stringify({ error: 'Too many requests, slow down' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY) {
    return new Response(JSON.stringify({ error: 'Server is missing OPENAI_API_KEY and GEMINI_API_KEY' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { images, prompt } = body;
  if (!images || !prompt) {
    return new Response(JSON.stringify({ error: 'Request must include images and prompt' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const imageList = Array.isArray(images) ? images : [images];

  const errors = [];

  try {
    const url = await stageWithOpenAI(imageList, prompt);
    return new Response(JSON.stringify({ code: 0, data: { url } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    errors.push(`OpenAI: ${err.message}`);
  }

  try {
    const url = await stageWithGemini(imageList, prompt);
    return new Response(JSON.stringify({ code: 0, data: { url } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    errors.push(`Gemini: ${err.message}`);
  }

  return new Response(JSON.stringify({ code: 1, message: errors.join(' | '), data: null }), {
    status: 502,
    headers: { 'Content-Type': 'application/json' },
  });
}
