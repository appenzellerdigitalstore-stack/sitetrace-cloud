// =====================================================================
// sitetrace-api — Redirect Chain Tracer (Cloudflare Workers)
//
// Endpoint: GET /api/redirect-trace?url=...
// Auth: shared middleware (functions/_middleware.js)
// =====================================================================

const MAX_HOPS = 10;
const DEFAULT_TIMEOUT_MS = 5000;
const USER_AGENT = 'sitetrace-api/1.0 (+https://api.sitetrace.it.com/api/redirect-trace)';

// ---------------------------------------------------------------------
// Pure logic (also exported for Node.js test runner via conditional
// module.exports at the bottom of the file)
// ---------------------------------------------------------------------

function normalizeUrl(input) {
  if (!input || typeof input !== 'string') throw new Error('URL is required');
  const v = input.trim();
  const withProto = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  const u = new URL(withProto);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http/https');
  if (['localhost', '0.0.0.0', '127.0.0.1'].includes(u.hostname)) {
    throw new Error('Local URLs not supported');
  }
  return u;
}

function classifyChain(chain) {
  const last = chain[chain.length - 1];
  const http2https = chain.some(
    (c, i) => i > 0 && c.url.startsWith('http:') && chain[i - 1]?.url.startsWith('https:')
  );
  const https2http = chain.some(
    (c, i) => i > 0 && c.url.startsWith('https:') && chain[i - 1]?.url.startsWith('http:')
  );
  const totalHops = chain.length;
  const totalLatency = chain.reduce((s, c) => s + (c.latency_ms || 0), 0);
  const finalStatus = last?.status || 0;
  const isBroken = finalStatus >= 400 || !!last?.error;
  const isRedirectLoop = !!chain.find((c) => c.error === 'redirect_loop_detected');
  const isTooLong = chain.length >= MAX_HOPS && !isRedirectLoop;

  const issues = [];
  if (http2https) issues.push('protocol_downgrade (https → http)');
  if (https2http && !http2https) issues.push('protocol_upgrade_detected');
  if (isBroken) issues.push(`final_status_${finalStatus || 'error'}`);
  if (isRedirectLoop) issues.push('redirect_loop');
  if (isTooLong) issues.push('too_many_redirects');
  if (totalHops > 3 && !isBroken) issues.push('excessive_redirects');

  return {
    total_hops: totalHops,
    total_latency_ms: totalLatency,
    final_url: last?.url || null,
    final_status: finalStatus,
    is_broken: isBroken,
    is_redirect_loop: isRedirectLoop,
    exceeds_max_hops: isTooLong,
    issues,
  };
}

async function traceChain(startUrl, fetchFn = fetch, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const chain = [];
  let currentUrl = startUrl;
  const seen = new Set();
  for (let i = 0; i < MAX_HOPS; i++) {
    if (seen.has(currentUrl)) {
      chain.push({ hop: i + 1, url: currentUrl, error: 'redirect_loop_detected' });
      break;
    }
    seen.add(currentUrl);
    const start = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let resp, error = null;
    try {
      resp = await fetchFn(currentUrl, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'User-Agent': USER_AGENT },
      });
    } catch (e) {
      error = e.name === 'AbortError' ? 'timeout' : (e?.message || 'fetch_failed');
    } finally {
      clearTimeout(timer);
    }
    const latency_ms = Date.now() - start;
    if (error) {
      chain.push({ hop: i + 1, url: currentUrl, latency_ms, error });
      break;
    }
    const status = resp.status;
    const location = resp.headers.get('location');
    chain.push({
      hop: i + 1,
      url: currentUrl,
      status,
      location: location || null,
      content_type: resp.headers.get('content-type'),
      latency_ms,
    });
    if (status < 300 || status >= 400) break;
    if (!location) break;
    try {
      currentUrl = new URL(location, currentUrl).href;
    } catch (_) {
      chain.push({ hop: i + 2, url: currentUrl, error: 'invalid_next_url' });
      break;
    }
  }
  return chain;
}

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      ...extraHeaders,
    },
  });
}

// ---------------------------------------------------------------------
// Plan-based filter
// ---------------------------------------------------------------------

function filterByPlan(plan, analysis, chain) {
  const out = {
    success: true,
    summary: {
      total_hops: analysis.total_hops,
      final_status: analysis.final_status,
      is_broken: analysis.is_broken,
      is_redirect_loop: analysis.is_redirect_loop,
      exceeds_max_hops: analysis.exceeds_max_hops,
      issues: analysis.issues,
    },
    plan,
  };
  // Pro tier gets hop details (status + location per hop)
  if (plan !== 'free') {
    out.chain = chain.map((c) => ({
      hop: c.hop,
      url: c.url,
      status: c.status || null,
      location: c.location || null,
    }));
  }
  // Ultra+ gets timing too
  if (plan === 'ultra' || plan === 'mega') {
    out.total_latency_ms = analysis.total_latency_ms;
    out.chain = chain;
  }
  return out;
}

// ---------------------------------------------------------------------
// Cloudflare Workers handlers
// ---------------------------------------------------------------------

export async function onRequestGet(context) {
  const { request, data } = context;
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url');

  if (!targetUrl) {
    return jsonResponse({
      error: 'invalid_request',
      message: 'Provide a valid URL. Example: /api/redirect-trace?url=https://bit.ly/example',
    }, 400);
  }
  let parsed;
  try {
    parsed = normalizeUrl(targetUrl);
  } catch (e) {
    return jsonResponse({ error: 'invalid_url', message: e.message }, 400);
  }

  let chain;
  try {
    chain = await traceChain(parsed.href);
  } catch (e) {
    return jsonResponse({ error: 'trace_failed', message: e?.message || 'unknown' }, 502);
  }

  const analysis = classifyChain(chain);
  const plan = data?.user?.plan || 'free';
  const result = filterByPlan(plan, analysis, chain);
  return jsonResponse(result, 200);
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}

// Dual-export: Cloudflare Workers ignore `module` (this file just exports the
// handlers via top-level `export`); Node test runner imports the helpers below.
if (typeof module !== 'undefined') {
  module.exports = { normalizeUrl, traceChain, classifyChain, filterByPlan, jsonResponse, MAX_HOPS };
}