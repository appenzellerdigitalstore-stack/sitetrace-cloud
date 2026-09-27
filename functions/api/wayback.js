// =====================================================================
// sitetrace-api — Wayback Machine Snapshot (Cloudflare Workers)
//
// Endpoint: GET /api/wayback?url=...&from=YYYYMMDD&to=YYYYMMDD
// Auth: shared middleware (functions/_middleware.js)
// =====================================================================

const CDX_URL = 'https://web.archive.org/cdx/search/cdx';
const DEFAULT_TIMEOUT_MS = 30000; // CDX server can be slow; 30s is realistic
const MAX_SNAPSHOTS = 1000;
const DEFAULT_LIMIT = 50;

// ---------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------

function normalizeUrl(input) {
  if (!input || typeof input !== 'string') throw new Error('URL is required');
  const v = input.trim();
  const withProto = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  const u = new URL(withProto);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http/https');
  return u;
}

function normalizeDate(date, direction) {
  // accepts YYYYMMDD or YYYY-MM-DD; returns YYYYMMDD or null
  if (!date) return null;
  const cleaned = date.replace(/[^0-9]/g, '');
  if (cleaned.length === 8) return cleaned;
  if (cleaned.length === 12) return cleaned.slice(0, 8); // YYYYMMDDhhmm
  throw new Error(`Invalid date (expected YYYYMMDD): ${date}`);
}

function buildCdxUrl(normalizedUrl, opts = {}) {
  const params = new URLSearchParams({
    url: normalizedUrl,
    output: 'json',
    limit: String(Math.min(opts.limit || DEFAULT_LIMIT, MAX_SNAPSHOTS)),
  });
  if (opts.from) params.set('from', opts.from);
  if (opts.to) params.set('to', opts.to);
  if (opts.filter) params.set('filter', opts.filter);
  if (opts.matchType) params.set('matchType', opts.matchType);
  return `${CDX_URL}?${params.toString()}`;
}

// CDX returns: first row = column header (e.g. ["urlkey","timestamp","original",...])
function parseCdx(json, opts = {}) {
  if (!Array.isArray(json) || json.length < 2) return [];
  const header = json[0];
  const idxTimestamp = header.indexOf('timestamp');
  const idxOriginal = header.indexOf('original');
  const idxMime = header.indexOf('mimetype');
  const idxStatus = header.indexOf('statuscode');
  const idxDigest = header.indexOf('digest');
  const idxLength = header.indexOf('length');
  const out = [];
  for (let i = 1; i < json.length; i++) {
    const row = json[i];
    if (!Array.isArray(row)) continue;
    const ts = idxTimestamp >= 0 ? row[idxTimestamp] : null;
    const orig = idxOriginal >= 0 ? row[idxOriginal] : null;
    if (!ts || !orig) continue;
    const status = idxStatus >= 0 ? parseInt(row[idxStatus], 10) : null;
    out.push({
      timestamp: ts,
      timestamp_iso: ts ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)}Z` : null,
      url: orig,
      status,
      content_type: idxMime >= 0 ? row[idxMime] : null,
      digest: idxDigest >= 0 ? row[idxDigest] : null,
      length: idxLength >= 0 ? parseInt(row[idxLength], 10) || null : null,
      archived_url: ts && orig ? `https://web.archive.org/web/${ts}/${orig}` : null,
    });
    if (out.length >= MAX_SNAPSHOTS) break;
  }
  return out;
}

function summarize(snapshots) {
  if (snapshots.length === 0) {
    return {
      total: 0,
      first_snapshot: null,
      last_snapshot: null,
      status_breakdown: {},
      most_common_status: null,
    };
  }
  const statusCounts = {};
  for (const s of snapshots) {
    const k = s.status ? String(s.status) : 'unknown';
    statusCounts[k] = (statusCounts[k] || 0) + 1;
  }
  const mostCommon = Object.entries(statusCounts)
    .sort((a, b) => b[1] - a[1])[0];
  return {
    total: snapshots.length,
    first_snapshot: snapshots[0]?.timestamp_iso || null,
    last_snapshot: snapshots[snapshots.length - 1]?.timestamp_iso || null,
    status_breakdown: statusCounts,
    most_common_status: mostCommon ? `${mostCommon[0]} (×${mostCommon[1]})` : null,
  };
}

// ---------------------------------------------------------------------
// Plan-based filter
// ---------------------------------------------------------------------

function filterByPlan(plan, snapshots, summary) {
  const out = {
    success: true,
    summary,
    snapshots: snapshots.map((s) => ({
      timestamp: s.timestamp,
      timestamp_iso: s.timestamp_iso,
      url: s.url,
      status: s.status,
    })),
    plan,
  };
  if (plan === 'free') {
    return out;
  }
  // Pro+ gets full snapshots
  out.snapshots = snapshots;
  if (plan === 'ultra' || plan === 'mega') {
    // Add archived_url with click-to-archive links
    out.snapshots = snapshots.map((s) => ({ ...s, archived_url: s.archived_url }));
  }
  return out;
}

// ---------------------------------------------------------------------
// Cloudflare Worker handler
// ---------------------------------------------------------------------

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

export async function onRequestGet(context) {
  const { request, data } = context;
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url');
  if (!targetUrl) {
    return jsonResponse({
      error: 'invalid_request',
      message: 'Provide a valid URL. Example: /api/wayback?url=example.com',
    }, 400);
  }
  let parsed;
  try {
    parsed = normalizeUrl(targetUrl);
  } catch (e) {
    return jsonResponse({ error: 'invalid_url', message: e.message }, 400);
  }

  let from = null, to = null, limit = DEFAULT_LIMIT;
  try {
    from = normalizeDate(url.searchParams.get('from'));
    to = normalizeDate(url.searchParams.get('to'));
    const l = url.searchParams.get('limit');
    if (l) limit = Math.min(parseInt(l, 10) || DEFAULT_LIMIT, MAX_SNAPSHOTS);
  } catch (e) {
    return jsonResponse({ error: 'invalid_param', message: e.message }, 400);
  }

  const cacheKey = `wayback?url=${encodeURIComponent(parsed.href)}&from=${from || ''}&to=${to || ''}&limit=${limit}`;
  const cache = caches.default;
  const cacheKeyReq = new Request(`https://cache.local/${cacheKey}`, { method: 'GET' });
  const cached = await cache.match(cacheKeyReq);
  if (cached) {
    const h = new Headers(cached.headers);
    h.set('X-Cache', 'HIT');
    return new Response(cached.body, { status: cached.status, headers: h });
  }

  const plan = data?.user?.plan || 'free';
  const cdxUrl = buildCdxUrl(parsed.href, { from, to, limit });
  const start = Date.now();
  let snapshots = [];
  let httpError = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
    const resp = await fetch(cdxUrl, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'sitetrace-api/1.0' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) {
      return jsonResponse({
        error: 'cdx_error',
        status: resp.status,
        message: `Wayback CDX returned HTTP ${resp.status}`,
      }, 502);
    }
    const text = await resp.text();
    if (!text.trim()) {
      snapshots = [];
    } else {
      try {
        const json = JSON.parse(text);
        snapshots = parseCdx(json, { limit });
      } catch (e) {
        httpError = 'invalid_json_from_cdx';
      }
    }
  } catch (e) {
    return jsonResponse({
      error: 'cdx_failed',
      message: e.name === 'AbortError' ? 'Timeout fetching CDX' : e.message,
    }, 502);
  }

  const summary = summarize(snapshots);
  const result = filterByPlan(plan, snapshots, summary);
  result.cdx_query = cdxUrl;
  result.fetch_time_ms = Date.now() - start;
  result.http_error = httpError;

  const responseBody = JSON.stringify(result);
  const response = new Response(responseBody, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400',
      'X-Cache': 'MISS',
    },
  });
  try {
    await cache.put(cacheKeyReq, response.clone());
  } catch (_) { /* best-effort */ }

  return response;
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

if (typeof module !== 'undefined') {
  module.exports = {
    normalizeUrl,
    normalizeDate,
    buildCdxUrl,
    parseCdx,
    summarize,
    filterByPlan,
    MAX_SNAPSHOTS,
    DEFAULT_LIMIT,
  };
}