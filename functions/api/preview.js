// =====================================================================
// sitetrace-api — URL Preview / Open Graph Extractor
//
// Endpoint: GET /api/preview?url=https://example.com
//
// Fetches the URL, parses the HTML, returns:
//   { url, final_url, title, description, image, favicon, site_name,
//     type, locale, theme_color, og: { ... }, twitter: { ... } }
//
// Auth: shared middleware. The endpoint is also the metadata layer
//       for the screenshot API — if you want both, hit /api/shot
//       (which uses this same fetch + parse under the hood).
//
// Notes for future-you:
//   - We do NOT execute JS. Static HTML parsing only. If the page is
//     a SPA that hydrates client-side, og:* tags injected by the
//     JS will be missing. For those, the screenshot API is more
//     accurate.
//   - We follow up to 3 redirects. We bail at 2 MB read (don't
//     download the whole internet).
// =====================================================================

const TIMEOUT_MS = 12000;
const MAX_BYTES = 2 * 1024 * 1024;

function normalizeUrl(input) {
  if (!input || typeof input !== 'string') return null;
  let s = input.trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!u.hostname.includes('.')) return null;
    return u.toString();
  } catch (_) { return null; }
}

// Resolve a possibly-relative URL against a base
function absolutize(maybe, base) {
  if (!maybe || typeof maybe !== 'string') return null;
  try {
    return new URL(maybe, base).toString();
  } catch (_) { return null; }
}

// Extract the value of <meta property="..." content="...">
// Returns a string or null. Handles attribute order and quote style.
function metaContent(html, attr, key) {
  // Two shapes: <meta property="og:title" content="..."> and
  // <meta name="twitter:title" content="...">. We use a single
  // regex that captures both keys.
  const re = new RegExp(
    '<meta\\s+(?:[^>]*?\\s)?' + attr + '="' + key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&') + '"[^>]*?content="([^"]*)"',
    'i'
  );
  const m = html.match(re);
  if (m) return decodeHtml(m[1]);
  // Try the other attribute order
  const re2 = new RegExp(
    '<meta\\s+(?:[^>]*?\\s)?content="([^"]*)"[^>]*?' + attr + '="' + key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&') + '"',
    'i'
  );
  const m2 = html.match(re2);
  if (m2) return decodeHtml(m2[1]);
  return null;
}

function metaContentQuoted(html, attr, key) {
  // Same as metaContent but tolerates single quotes too
  const re = new RegExp(
    "<meta\\s+(?:[^>]*?\\s)?" + attr + "=['\"]" + key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&') + "['\"][^>]*?content=['\"]([^'\"]*)['\"]",
    'i'
  );
  const m = html.match(re);
  return m ? decodeHtml(m[1]) : null;
}

function linkHref(html, rel) {
  const re = new RegExp('<link\\s+(?:[^>]*?\\s)?rel=["\']' + rel + '["\'][^>]*?href=["\']([^"\']*)["\']', 'i');
  const m = html.match(re);
  if (m) return m[1];
  const re2 = new RegExp('<link\\s+(?:[^>]*?\\s)?href=["\']([^"\']*)["\'][^>]*?rel=["\']' + rel + '["\']', 'i');
  const m2 = html.match(re2);
  return m2 ? m2[1] : null;
}

function titleFromHtml(html) {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? decodeHtml(m[1].trim()) : null;
}

function decodeHtml(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function getOg(html, base) {
  const fields = ['title', 'description', 'image', 'url', 'site_name', 'type', 'locale', 'audio', 'video', 'determiner'];
  const out = {};
  for (const f of fields) {
    const v = metaContent(html, 'property', 'og:' + f) || metaContentQuoted(html, 'property', 'og:' + f);
    if (v) out[f] = f === 'image' || f === 'audio' || f === 'video' || f === 'url' ? absolutize(v, base) : v;
  }
  // og:image:secure_url / og:image:width / og:image:height
  const sec = metaContent(html, 'property', 'og:image:secure_url');
  if (sec) out.image_secure_url = absolutize(sec, base);
  return out;
}

function getTwitter(html, base) {
  const fields = ['card', 'site', 'creator', 'title', 'description', 'image', 'image:alt'];
  const out = {};
  for (const f of fields) {
    const v = metaContent(html, 'name', 'twitter:' + f) || metaContentQuoted(html, 'name', 'twitter:' + f);
    if (v) out[f] = f === 'image' ? absolutize(v, base) : v;
  }
  return out;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const targetUrl = normalizeUrl(url.searchParams.get('url'));
  if (!targetUrl) {
    return json({ error: 'invalid_url', message: 'Provide a valid http(s) URL.' }, 400);
  }

  const start = Date.now();
  let resp;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    resp = await fetch(targetUrl, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        // Some sites send different HTML to bots vs browsers. The
        // facebookexternalhit UA gets the most og-tag-rich variant.
        'User-Agent': 'facebookexternalhit/1.1 (+https://api.sitetrace.it.com)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    clearTimeout(t);
  } catch (e) {
    return json({ error: 'fetch_failed', message: (e && e.message) || 'Could not fetch the URL', url: targetUrl }, 502);
  }

  const ct = resp.headers.get('content-type') || '';
  if (!/text\/html|application\/xhtml/i.test(ct)) {
    return json({ error: 'not_html', message: 'URL did not return HTML (content-type: ' + ct + ').', url: targetUrl }, 415);
  }

  // Read up to MAX_BYTES of the body
  const reader = resp.body.getReader();
  let received = 0;
  const chunks = [];
  while (received < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    chunks.push(value);
  }
  try { await reader.cancel(); } catch (_) {}
  const buf = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  const html = new TextDecoder('utf-8', { fatal: false }).decode(buf);

  const finalUrl = resp.url;
  const baseUrl = finalUrl;

  const og = getOg(html, baseUrl);
  const tw = getTwitter(html, baseUrl);
  const title = og.title || tw.title || titleFromHtml(html) || null;
  const description = og.description || tw.description
    || metaContent(html, 'name', 'description') || metaContentQuoted(html, 'name', 'description')
    || null;
  const image = og.image || tw.image || null;
  const favicon = absolutize(linkHref(html, 'icon') || linkHref(html, 'shortcut icon') || '/favicon.ico', baseUrl);
  const themeColor = metaContent(html, 'name', 'theme-color') || metaContentQuoted(html, 'name', 'theme-color');

  return json({
    url: targetUrl,
    final_url: finalUrl,
    fetched_ms: Date.now() - start,
    title,
    description,
    image,
    favicon,
    site_name: og.site_name || null,
    type: og.type || null,
    locale: og.locale || null,
    theme_color: themeColor,
    og,
    twitter: tw,
  });
}
