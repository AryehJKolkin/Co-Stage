// Proxies CoStage's staging requests to Google's Gemini image model so the
// API key lives only in the GEMINI_API_KEY environment variable (set in the
// Vercel dashboard, or in .env for local `vercel dev`) — it never reaches
// the browser.

export const config = { runtime: 'edge' };

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3-pro-image-preview';

// Best-effort per-instance rate limit. Resets on cold start and isn't shared
// across instances — it's defense-in-depth against a runaway loop or casual
// abuse, not a substitute for the key's own spending limits.
const RATE_LIMIT = 12;          // requests
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

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Accepts either a data URL (from an uploaded file) or an http(s) URL (e.g.
// a furniture catalogue reference photo) and returns Gemini's inlineData shape.
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

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return new Response(JSON.stringify({ error: 'Server is missing GEMINI_API_KEY' }), {
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

  let parts;
  try {
    const inlineParts = await Promise.all(imageList.map(async img => ({ inlineData: await toInlineData(img) })));
    parts = [...inlineParts, { text: prompt }];
  } catch (err) {
    return new Response(JSON.stringify({ error: `Failed to prepare images: ${err.message}` }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const geminiRes = await fetch(`${GEMINI_ENDPOINT}/${GEMINI_MODEL}:generateContent`, {
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

  const geminiData = await geminiRes.json();
  if (!geminiRes.ok) {
    return new Response(JSON.stringify({ code: geminiRes.status, message: geminiData.error?.message || 'Gemini API error', data: null }), {
      status: geminiRes.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const responseParts = geminiData.candidates?.[0]?.content?.parts || [];
  const imagePart = responseParts.find(p => p.inlineData);
  if (!imagePart) {
    return new Response(JSON.stringify({ code: 1, message: 'Gemini returned no image', data: null }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`;
  return new Response(JSON.stringify({ code: 0, data: { url } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
