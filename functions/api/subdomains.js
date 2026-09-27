// =====================================================================
// sitetrace-api — Subdomain Enumerator (Cloudflare Workers)
//
// Endpoint: GET /api/subdomains?domain=example.com
// Auth: shared middleware (functions/_middleware.js)
// =====================================================================

const CRT_SH_URL = 'https://crt.sh';
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_SUBDOMAINS = 5000;

// ---------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------

function normalizeDomain(input) {
  if (!input || typeof input !== 'string') throw new Error('Domain is required');
  let v = input.trim().toLowerCase();
  v = v.replace(/^https?:\/\//, '');
  v = v.replace(/^www\./, '');
  const slash = v.indexOf('/');
  if (slash >= 0) v = v.slice(0, slash);
  if (!/^[a-z0-9.\-]+$/.test(v)) throw new Error('Domain contains invalid characters');
  if (!v.includes('.')) throw new Error('Domain must include a TLD');
  return v;
}

function apexFromAny(host) {
  // Extract registrable apex from any subdomain form (best-effort).
  // For 2-part TLDs (co.uk, com.hn, etc.) we'd need the public suffix list;
  // for simplicity we treat the last 2 labels as the apex. For our target
  // search we don't actually need this because crt.sh returns subdomains with
  // the queried domain as a suffix.
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  return parts.slice(-2).join('.');
}

function dedupeAndFilterSubdomains(rawList, apex) {
  const apexLower = apex.toLowerCase();
  const set = new Set();
  for (const raw of rawList) {
    if (typeof raw !== 'string') continue;
    const v = raw.trim().toLowerCase();
    if (!v) continue;
    // Strip any wildcard prefix
    if (v.startsWith('*.')) continue;
    // Must be a subdomain (or equal) of our apex
    if (v !== apexLower && !v.endsWith('.' + apexLower)) continue;
    if (!/^[a-z0-9.\-]+$/.test(v)) continue;
    set.add(v);
    if (set.size >= MAX_SUBDOMAINS) break;
  }
  return Array.from(set).sort();
}

function countByTier(subdomains) {
  let totalCount = subdomains.length;
  let uniqueApexOnly = subdomains.filter((d) => !d.includes('.', d.indexOf('.') + 1)).length;
  let multiLabel = totalCount - uniqueApexOnly;
  return { total: totalCount, apex_match: uniqueApexOnly, multi_label: multiLabel };
}

// ---------------------------------------------------------------------
// crt.sh response parsing
// ---------------------------------------------------------------------

function parseCrtSh(json, apex) {
  // crt.sh returns an array of objects, each with `common_name`, `name_value`,
  // and a few other fields. Either common_name or name_value may contain the
  // candidate subdomain(s). name_value can be multi-line (one per line).
  const out = [];
  if (!Array.isArray(json)) return out;
  for (const row of json) {
    if (row.common_name && typeof row.common_name === 'string') out.push(row.common_name);
    if (row.name_value && typeof row.name_value === 'string') {
      for (const line of row.name_value.split(/\n+/)) {
        out.push(line.trim());
      }
    }
  }
  return dedupeAndFilterSubdomains(out, apex);
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
  const targetDomain = url.searchParams.get('domain') || url.searchParams.get('url');
  if (!targetDomain) {
    return jsonResponse({
      error: 'invalid_request',
      message: 'Provide a domain. Example: /api/subdomains?domain=example.com',
    }, 400);
  }
  let domain;
  try {
    domain = normalizeDomain(targetDomain);
  } catch (e) {
    return jsonResponse({ error: 'invalid_domain', message: e.message }, 400);
  }

  const cache = caches.default;
  const cacheKeyReq = new Request(
    `https://cache.local/subdomains?domain=${encodeURIComponent(domain)}`,
    { method: 'GET', headers: { 'Cache-Domain': domain } },
  );
  const cached = await cache.match(cacheKeyReq);
  if (cached) {
    const h = new Headers(cached.headers);
    h.set('X-Cache', 'HIT');
    return new Response(cached.body, { status: cached.status, headers: h });
  }

  const plan = data?.user?.plan || 'free';
  const start = Date.now();
  let crtJson;
  let httpError = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
    const resp = await fetch(`${CRT_SH_URL}/?q=%25.${domain}&output=json`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'sitetrace-api/1.0 (+https://api.sitetrace.it.com/api/subdomains)',
      },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) {
      return jsonResponse({
        error: 'crt_sh_error',
        status: resp.status,
        message: `crt.sh returned HTTP ${resp.status}`,
      }, 502);
    }
    const text = await resp.text();
    if (!text.trim()) {
      // crt.sh returns empty body when no results — not an error
      crtJson = [];
    } else {
      try {
        crtJson = JSON.parse(text);
      } catch (_) {
        crtJson = [];
        httpError = 'invalid_json_from_crt_sh';
      }
    }
  } catch (e) {
    return jsonResponse({
      error: 'crt_sh_failed',
      message: e.name === 'AbortError' ? 'Timeout fetching crt.sh (20s)' : e.message,
    }, 502);
  }

  const all = parseCrtSh(crtJson, domain);
  const tierCounts = countByTier(all);

  // Free tier cap
  const result_list = plan === 'free' ? all.slice(0, 50) : all;

  const responseBody = JSON.stringify({
    success: true,
    domain,
    data_source: 'crt.sh',
    source_query: `q=%25.${domain}`,
    total_subdomains_found: all.length,
    returned: result_list.length,
    counts: tierCounts,
    http_error: httpError,
    fetch_time_ms: Date.now() - start,
    subdomains: result_list,
    plan,
  });
  const response = new Response(responseBody, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600',
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
    normalizeDomain,
    apexFromAny,
    dedupeAndFilterSubdomains,
    countByTier,
    parseCrtSh,
  };
}