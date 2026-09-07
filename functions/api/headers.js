// =====================================================================
// sitetrace-api — HTTP Headers (security header analysis)
//
// Endpoint: GET /api/headers?url=https://example.com
//
// Fetches the URL, inspects the security-relevant response headers,
// returns a 0-100 score + per-header pass/fail. Same logic as
// sitetrace's /api/http-headers, re-implemented for self-containment.
//
// Auth: shared middleware.
// =====================================================================

const TIMEOUT_MS = 12000;
const MAX_BYTES = 2 * 1024 * 1024; // cap the fetch at 2 MB; we only need headers

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

const HEADER_CHECKS = [
  { id: 'hsts',           header: 'strict-transport-security',  weight: 15, pass: (v) => /max-age=\d{8,}/i.test(v) },
  { id: 'csp',            header: 'content-security-policy',    weight: 20, pass: (v) => v && v.length > 10 },
  { id: 'x_frame',        header: 'x-frame-options',            weight: 10, pass: (v) => /deny|sameorigin/i.test(v) },
  { id: 'x_content',      header: 'x-content-type-options',     weight: 10, pass: (v) => /nosniff/i.test(v) },
  { id: 'referrer',       header: 'referrer-policy',            weight: 5,  pass: (v) => /(strict-origin|no-referrer|origin|same-origin)/i.test(v) },
  { id: 'permissions',    header: 'permissions-policy',         weight: 5,  pass: (v) => v && v.length > 0 },
  { id: 'x_xss',          header: 'x-xss-protection',           weight: 0,  pass: () => true }, // deprecated; OK if absent
  { id: 'server',         header: 'server',                     weight: 0,  pass: () => true }, // info only
];

function grade(score) {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
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
      headers: { 'User-Agent': 'Sitetrace-Headers/1.0 (+https://api.sitetrace.it.com)' },
    });
    clearTimeout(t);
  } catch (e) {
    return json({
      error: 'fetch_failed',
      message: (e && e.message) || 'Could not fetch the URL',
      url: targetUrl,
    }, 502);
  }

  // Stop the body from being read past the cap (saves bandwidth)
  try { resp.body?.cancel?.(); } catch (_) {}

  const headers = {};
  resp.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });

  let score = 0;
  const checks = [];
  for (const c of HEADER_CHECKS) {
    const v = headers[c.header];
    const pass = c.weight > 0 && v && c.pass(v);
    if (pass) score += c.weight;
    checks.push({
      id: c.id,
      header: c.header,
      present: !!v,
      value: v || null,
      pass,
      weight: c.weight,
    });
  }
  if (score > 100) score = 100;

  return json({
    url: targetUrl,
    final_url: resp.url,
    status: resp.status,
    fetched_ms: Date.now() - start,
    score,
    grade: grade(score),
    checks,
    all_headers: headers,
  });
}
