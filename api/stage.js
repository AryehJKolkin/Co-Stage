// Proxies CoStage's nano-banana staging requests through a serverless function
// so the API key lives only in the NANOBANANA_API_KEY environment variable
// (set in the Vercel dashboard, or in .env for local `vercel dev`) — it
// never reaches the browser.

export const config = { runtime: 'edge' };

const NB_ENDPOINT = 'https://api.nanobananaapi.dev/v1/images/edit';
const NB_MODEL = 'gemini-3-pro-image-preview';

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

// Lightweight session gate: the frontend prompts for this passphrase once and
// sends it on every request. Set SITE_ACCESS_KEY in the Vercel dashboard to
// require it; leave it unset to allow anyone with the site URL to use staging.
function hasValidSiteKey(req) {
  const required = process.env.SITE_ACCESS_KEY;
  if (!required) return true; // gate disabled
  return req.headers.get('x-site-key') === required;
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

  if (!hasValidSiteKey(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized — enter the site access passphrase' }), {
      status: 401,
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

  const key = process.env.NANOBANANA_API_KEY;
  if (!key) {
    return new Response(JSON.stringify({ error: 'Server is missing NANOBANANA_API_KEY' }), {
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

  const nbRes = await fetch(NB_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: NB_MODEL,
      image: Array.isArray(images) ? images : [images],
      prompt,
      num: 1,
    }),
  });

  const data = await nbRes.text();
  return new Response(data, {
    status: nbRes.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
