// =====================================================================
// sitetrace-api — SSL/TLS Certificate Transparency Lookup
//
// Endpoint: GET /api/certs?domain=example.com
//
// Wraps crt.sh (public CT log search) with a clean JSON shape +
// 24h cache. crt.sh is rate-limited + slow; we soften both.
//
// Auth: shared middleware. Free tier: 50/day (the upstream is heavy).
//       Paid tiers: 500/5k/20k per day.
//
// Notes for future-you:
//   - crt.sh returns every certificate ever issued for the queried
//     domain (and any subdomain containing it as a label). That
//     includes expired certs, which is exactly what brand-monitoring
//     customers want.
//   - We do NOT add a key. crt.sh is open and rate-limited per
//     source IP. A heavy customer should self-host their own
//     aggregation, in which case the paid tier covers infra.
//   - Cache key includes the `exclude` param. TTL is 24h — crt.sh
//     updates within minutes of a new cert, but a 24h view is
//     fine for "what certs have been issued to my brand".
// =====================================================================

const CRTSH = 'https://crt.sh';
const TIMEOUT_MS = 20000;
const CACHE_TTL_S = 24 * 3600;

function normalizeDomain(input) {
  if (!input || typeof input !== 'string') return null;
  let s = input.trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').replace(/:.*$/, '');
  if (s.length > 253) return null;
  if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(s)) return null;
  return s;
}

function parseExcludes(v) {
  if (!v) return new Set();
  return new Set(
    v.split(',')
      .map(x => x.trim().toLowerCase())
      .filter(Boolean)
  );
}

async function fetchCrtsh(domain) {
  const u = `${CRTSH}/?q=${encodeURIComponent(domain)}&output=json&dedupe=1`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(u, {
      headers: { 'User-Agent': 'Sitetrace-API/1.0 (+https://api.sitetrace.it.com)' },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!resp.ok) {
      return { ok: false, status: resp.status, error: `crtsh_http_${resp.status}` };
    }
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch (_) {
      return { ok: false, status: 502, error: 'crtsh_not_json' };
    }
    return { ok: true, certs: data };
  } catch (e) {
    return { ok: false, status: 502, error: e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || 'error' };
  }
}

function shape(cert, excludes) {
  const names = (cert.name_value || '').split('\n').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (names.length === 0) return null;
  if (names.some(n => excludes.has(n))) return null;
  return {
    id: cert.id,
    issuer: cert.issuer_name || null,
    issuer_dn: cert.issuer_dn || null,
    common_name: (cert.common_name || '').toLowerCase() || null,
    name_value: names,
    not_before: cert.not_before || null,
    not_after: cert.not_after || null,
    serial_number: cert.serial_number || null,
    ca: cert.ca || null,
    crl: cert.crl || null,
  };
}

function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    }, extra || {}),
  });
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const domain = normalizeDomain(url.searchParams.get('domain'));
  if (!domain) {
    return json({ error: 'invalid_domain', message: 'Provide a valid domain (e.g. example.com).' }, 400);
  }
  const excludes = parseExcludes(url.searchParams.get('exclude'));
  const limit = Math.max(1, Math.min(1000, parseInt(url.searchParams.get('limit'), 10) || 200));

  // KV cache (24h)
  const cacheKey = `certs:v1:${domain}:${Array.from(excludes).sort().join(',') || 'none'}`;
  if (env.RATELIMIT) {
    try {
      const cached = await env.RATELIMIT.get(cacheKey, 'json');
      if (cached && cached.fetched_at > Date.now() / 1000 - CACHE_TTL_S) {
        const body = { ...cached, cache: 'HIT' };
        return json(body, 200, { 'X-Cache': 'HIT' });
      }
    } catch (_) { /* cache miss is fine */ }
  }

  const r = await fetchCrtsh(domain);
  if (!r.ok) {
    return json({ error: r.error, message: 'crt.sh query failed' }, r.status);
  }

  let shaped = r.certs
    .map(c => shape(c, excludes))
    .filter(Boolean);

  // Sort by not_before desc
  shaped.sort((a, b) => (b.not_before || '').localeCompare(a.not_before || ''));
  if (shaped.length > limit) shaped = shaped.slice(0, limit);

  const body = {
    domain,
    count: shaped.length,
    fetched_at: Math.floor(Date.now() / 1000),
    cache: 'MISS',
    certs: shaped,
  };

  if (env.RATELIMIT) {
    try { await env.RATELIMIT.put(cacheKey, JSON.stringify(body), { expirationTtl: CACHE_TTL_S }); } catch (_) {}
  }

  return json(body, 200, { 'X-Cache': 'MISS' });
}
