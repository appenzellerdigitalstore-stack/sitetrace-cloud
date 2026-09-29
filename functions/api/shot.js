// =====================================================================
// sitetrace-api — Screenshot API
//
// Endpoint: GET  /api/shot?url=https://example.com
//           GET  /api/shot?url=...&width=1280&height=720&full=true
//                  &wait=2000&dark=false&device=desktop
//
// Returns: image/png (binary)
//
// Auth: shared middleware. Free tier: 100 calls/day per IP.
//       Paid: 1k/30k/200k per day per the user's plan.
//
// Notes for future-you:
//   - Browser Rendering requires the Workers Paid plan ($5/mo, includes
//     500 min of browser time). Enable in CF dashboard:
//       Workers & Pages → Settings → Browser Rendering → Enable
//     Then add the [[browser]] binding to wrangler.toml.
//   - Each screenshot is ~2-3s (browser launch + navigation + capture).
//   - For local dev, the function returns a placeholder PNG so the
//     function flow can be tested without Browser Rendering.
// =====================================================================

// ---------------------------------------------------------------------
// Defaults & validation
// ---------------------------------------------------------------------
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 720;
const MAX_WIDTH = 3840;
const MAX_HEIGHT = 2160;

const VALID_DEVICES = new Set(['desktop', 'mobile', 'tablet']);
const DEVICE_VIEWPORTS = {
  desktop: { width: 1280, height: 720,  isMobile: false, hasTouch: false },
  mobile:  { width: 390,  height: 844,  isMobile: true,  hasTouch: true  },
  tablet:  { width: 820,  height: 1180, isMobile: true,  hasTouch: true  },
};

function normalizeUrl(input) {
  if (!input || typeof input !== 'string') return null;
  let s = input.trim();
  // Add protocol if missing — try https first, fall back to http later
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch (_) { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!u.hostname || !u.hostname.includes('.')) return null;
  // Block SSRF to internal IPs (basic check — Cloudflare also enforces
  // egress filtering but this is defense in depth)
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0'
      || host.endsWith('.local') || host.endsWith('.internal')) {
    return null;
  }
  return u.toString();
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function parseBool(v, dflt) {
  if (v === null || v === undefined) return dflt;
  return v === '1' || v === 'true' || v === 'yes';
}

function parseInt10(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

// ---------------------------------------------------------------------
// Placeholder PNG for local dev (when BROWSER binding is missing)
// ---------------------------------------------------------------------
// 1x1 transparent PNG. Lets you test the function flow + auth without
// needing Cloudflare Browser Rendering locally.
const PLACEHOLDER_PNG = Uint8Array.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63600100000005000159c1d8b80000000049454e44ae426082',
  hex => parseInt(hex, 16)
);

// ---------------------------------------------------------------------
// Screenshot via Cloudflare Browser Rendering
// ---------------------------------------------------------------------
async function takeScreenshot(env, url, opts) {
  // Lazy import so the function still works without @cloudflare/puppeteer
  // installed locally. The module name is built at runtime (not a
  // string literal) so wrangler's bundler doesn't try to resolve it
  // at build time. The Cloudflare runtime resolves it from the
  // Browser Rendering binding when the feature is enabled.
  const moduleName = '@cloudflare/puppeteer';
  const mod = await import(moduleName);
  const puppeteer = mod.default || mod;
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    if (opts.dark) {
      await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    }
    await page.setViewport({
      width: opts.width,
      height: opts.height,
      deviceScaleFactor: 1,
      isMobile: opts.isMobile,
      hasTouch: opts.hasTouch,
    });
    if (opts.userAgent) {
      await page.setUserAgent(opts.userAgent);
    }
    // Block unnecessary third-party tracking/analytics to speed up
    // the page and reduce the wait time. This is best-effort and
    // benign if the URLs don't exist.
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const u = req.url();
      if (/google-analytics\.com|googletagmanager\.com|doubleclick\.net|facebook\.com\/tr|hotjar\.com/.test(u)) {
        return req.abort();
      }
      req.continue();
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
    if (opts.wait > 0) {
      await new Promise(r => setTimeout(r, Math.min(opts.wait, 8000)));
    }
    const buffer = await page.screenshot({
      type: opts.format === 'jpeg' ? 'jpeg' : 'png',
      fullPage: opts.full,
      ...(opts.format === 'jpeg' ? { quality: clamp(opts.quality, 30, 100) } : {}),
    });
    return { ok: true, buffer };
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------
export async function onRequestGet(context) {
  const { request, env, data } = context;
  const url = new URL(request.url);

  const targetUrl = normalizeUrl(url.searchParams.get('url'));
  if (!targetUrl) {
    return new Response(JSON.stringify({
      error: 'invalid_url',
      message: 'Provide a valid http(s) URL. Example: /api/shot?url=https://example.com',
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  const device = url.searchParams.get('device') || 'desktop';
  if (!VALID_DEVICES.has(device)) {
    return new Response(JSON.stringify({
      error: 'invalid_device',
      message: 'device must be one of: desktop, mobile, tablet',
    }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }
  const vp = DEVICE_VIEWPORTS[device];

  const opts = {
    width:    clamp(parseInt10(url.searchParams.get('width'),  vp.width),  100, MAX_WIDTH),
    height:   clamp(parseInt10(url.searchParams.get('height'), vp.height), 100, MAX_HEIGHT),
    full:     parseBool(url.searchParams.get('full'), false),
    wait:     clamp(parseInt10(url.searchParams.get('wait'), 0), 0, 8000),
    dark:     parseBool(url.searchParams.get('dark'), false),
    format:   url.searchParams.get('format') === 'jpeg' ? 'jpeg' : 'png',
    quality:  parseInt10(url.searchParams.get('quality'), 80),
    isMobile: vp.isMobile,
    hasTouch: vp.hasTouch,
  };

  // Cache: 5 min at the edge. Most screenshots don't need to be
  // re-rendered for the same URL within minutes.
  const cacheKey = new Request(request.url, request);
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const h = new Headers(cached.headers);
    h.set('X-Cache', 'HIT');
    return new Response(cached.body, { status: cached.status, headers: h });
  }

  // Local dev path — no BROWSER binding
  if (!env.BROWSER) {
    return new Response(PLACEHOLDER_PNG, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=60',
        'X-Sitetrace-Dev': 'placeholder',
        'X-Sitetrace-Original-Url': targetUrl,
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  let result;
  try {
    result = await takeScreenshot(env, targetUrl, opts);
  } catch (e) {
    return new Response(JSON.stringify({
      error: 'screenshot_failed',
      message: (e && e.message) || 'Browser Rendering failed',
      url: targetUrl,
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  const ct = opts.format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const resp = new Response(result.buffer, {
    status: 200,
    headers: {
      'Content-Type': ct,
      'Cache-Control': 'public, max-age=300',
      'X-Sitetrace-Original-Url': targetUrl,
      'X-Sitetrace-Width': String(opts.width),
      'X-Sitetrace-Height': String(opts.height),
      'X-Sitetrace-Device': device,
      'Access-Control-Allow-Origin': '*',
    },
  });
  // Edge-cache the response (response body must be buffered, which
  // it already is — the Buffer is in memory)
  try { await cache.put(cacheKey, resp.clone()); } catch (_) { /* cache write is best-effort */ }
  return resp;
}
