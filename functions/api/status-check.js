// =====================================================================
// sitetrace-api — Bulk HTTP Status Checker (Cloudflare Workers)
//
// Endpoint: POST /api/status-check
// Body: { "urls": ["url1", "url2", ...] }
// Auth: shared middleware (functions/_middleware.js)
// =====================================================================

const DEFAULT_TIMEOUT_MS = 8000;
const USER_AGENT = 'sitetrace-api/1.0 (+https://api.sitetrace.it.com/api/status-check)';

// Plan-based batch limits
const BATCH_LIMITS = { free: 5, pro: 25, ultra: 100, mega: 250 };

// ---------------------------------------------------------------------
// Pure helpers (also exported for Node test runner)
// ---------------------------------------------------------------------

function normalizeUrl(input) {
  if (!input || typeof input !== 'string') throw new Error('URL is required');
  const v = input.trim();
  if (!v) throw new Error('Empty URL');
  const withProto = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  const u = new URL(withProto);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http/https');
  if (['localhost', '0.0.0.0', '127.0.0.1'].includes(u.hostname)) {
    throw new Error('Local URLs not supported');
  }
  return u;
}

function dedupeAndValidate(urls, maxBatch) {
  const seen = new Set();
  const normalized = [];
  for (const raw of urls.slice(0, maxBatch)) {
    if (typeof raw !== 'string') continue;
    try {
      const u = normalizeUrl(raw);
      if (seen.has(u.href)) continue;
      seen.add(u.href);
      normalized.push(u);
    } catch (_) { /* skip invalid */ }
  }
  return Array.from(normalized);
}

function classifyStatusRow(row) {
  const status = row.status || 0;
  if (row.error) return { label: 'error', is_broken: true, severity: 'fail', code: status || 'error' };
  if (status >= 200 && status < 300) return { label: 'ok', is_broken: false, severity: 'pass', code: status };
  if (status >= 300 && status < 400) return { label: 'redirect', is_broken: false, severity: 'info', code: status };
  if (status === 401 || status === 403) return { label: 'auth_required', is_broken: true, severity: 'warn', code: status };
  if (status === 404 || status === 410) return { label: 'not_found', is_broken: true, severity: 'fail', code: status };
  if (status >= 400 && status < 500) return { label: 'client_error', is_broken: true, severity: 'fail', code: status };
  if (status >= 500) return { label: 'server_error', is_broken: true, severity: 'fail', code: status };
  return { label: 'unknown', is_broken: true, severity: 'warn', code: status };
}

function summarizeResults(results) {
  const counts = { ok: 0, redirect: 0, auth_required: 0, not_found: 0, client_error: 0, server_error: 0, error: 0 };
  let totalLatency = 0;
  for (const r of results) {
    const c = classifyStatusRow(r);
    counts[c.label] = (counts[c.label] || 0) + 1;
    totalLatency += r.latency_ms || 0;
  }
  const healthy = counts.ok + counts.redirect;
  const healthyPct = results.length > 0 ? Math.round((healthy / results.length) * 100) : 0;
  return {
    total: results.length,
    healthy: counts.ok + counts.redirect,
    broken: results.length - (counts.ok + counts.redirect),
    healthy_pct: healthyPct,
    counts,
    total_latency_ms: totalLatency,
  };
}

async function checkOne(urlObj, fetchFn = fetch, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetchFn(urlObj.href, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    return {
      url: urlObj.href,
      status: resp.status,
      final_url: resp.url,
      content_type: resp.headers.get('content-type'),
      content_length: parseInt(resp.headers.get('content-length') || '0', 10) || null,
      latency_ms: Date.now() - start,
    };
  } catch (e) {
    return {
      url: urlObj.href,
      error: e.name === 'AbortError' ? 'timeout' : (e?.message || 'fetch_failed'),
      latency_ms: Date.now() - start,
    };
  } finally {
    clearTimeout(timer);
  }
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

async function readBody(request) {
  try {
    const ct = (request.headers.get('content-type') || '').toLowerCase();
    const raw = await request.text();
    if (!raw) return {};
    if (ct.includes('application/json')) return JSON.parse(raw);
    const params = new URLSearchParams(raw);
    const obj = {};
    for (const [k, v] of params) obj[k] = v;
    return obj;
  } catch (_) {
    return {};
  }
}

// ---------------------------------------------------------------------
// Plan-based filter
// ---------------------------------------------------------------------

function filterByPlan(plan, results, summary) {
  const out = {
    success: true,
    summary,
    plan,
    results: results.map((r) => {
      const c = classifyStatusRow(r);
      if (plan === 'free') {
        return { url: r.url, status: r.status || null, final_url: r.final_url, latency_ms: r.latency_ms, label: c.label, is_broken: c.is_broken };
      }
      if (plan === 'pro') {
        return {
          url: r.url, status: r.status || null, final_url: r.final_url,
          content_type: r.content_type, content_length: r.content_length,
          latency_ms: r.latency_ms, label: c.label, is_broken: c.is_broken,
        };
      }
      // Ultra / Mega: everything
      return { ...r, label: c.label, is_broken: c.is_broken, severity: c.severity };
    }),
  };
  return out;
}

// ---------------------------------------------------------------------
// Cloudflare Workers handlers
// ---------------------------------------------------------------------

export async function onRequestPost(context) {
  const { request, data } = context;
  const plan = data?.user?.plan || 'free';

  const body = await readBody(request);
  const urls = body?.urls || body?.url;
  if (!urls || (Array.isArray(urls) && urls.length === 0)) {
    return jsonResponse({ error: 'invalid_request', message: '"urls" array required' }, 400);
  }
  const list = Array.isArray(urls) ? urls : [urls];
  const limit = BATCH_LIMITS[plan] || BATCH_LIMITS.free;
  const normalized = dedupeAndValidate(list, limit);

  if (normalized.length === 0) {
    return jsonResponse({ error: 'invalid_request', message: 'No valid URLs after normalization' }, 400);
  }
  if (normalized.length < list.length) {
    // Some were dropped (invalid or duplicates)
  }

  const results = await Promise.all(normalized.map((u) => checkOne(u)));
  const summary = summarizeResults(results);
  const filtered = filterByPlan(plan, results, summary);
  return jsonResponse(filtered, 200);
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}

if (typeof module !== 'undefined') {
  module.exports = {
    normalizeUrl,
    dedupeAndValidate,
    classifyStatusRow,
    summarizeResults,
    checkOne,
    filterByPlan,
    BATCH_LIMITS,
  };
}