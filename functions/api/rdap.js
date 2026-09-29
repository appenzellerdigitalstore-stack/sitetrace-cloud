// =====================================================================
// sitetrace-api — RDAP / WHOIS Lookup endpoint (Cloudflare Workers)
//
// Uses the public RDAP service at rdap.org (HTTP-based WHOIS replacement).
//   - Free, no auth, no rate limit announced
//   - Structured JSON response (vs WHOIS plain-text)
//
// Endpoint: GET /api/rdap?domain=example.com
// Auth: shared middleware (functions/_middleware.js)
// =====================================================================

const RDAP_ORG_URL = 'https://rdap.org';
const DEFAULT_TIMEOUT_MS = 12000;          // RDAP servers vary in speed
const MAX_TEXT_BYTES = 256 * 1024;         // RDAP responses are < 100KB typically
const KV_CACHE_TTL_SECONDS = 86400;        // 24h — domain registration data rarely changes

// Fields redacted by registrars when privacy proxy is in use
// Browser-like User-Agent required by rdap.org (Cloudflare blocks custom UAs)
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 sitetrace-api/1.0';

const REDACTION_TOKENS = new Set([
  '',
  'redacted',
  'redacted for privacy',
  'redacted for gdpr',
  'data redacted',
  'not disclosed',
  'not disclosed by registry',
  'private',
  'withheld',
  'protected',
]);

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

function isRedacted(value) {
  if (value == null) return true;
  if (typeof value !== 'string') return false;
  return REDACTION_TOKENS.has(value.toLowerCase().trim());
}

// Normalize domain input — strip protocols, paths, queries, trailing slashes
function normalizeDomain(input) {
  if (!input || typeof input !== 'string') throw new Error('Domain is required');
  let value = input.trim().toLowerCase();
  // Strip URL parts if user pasted a URL
  value = value.replace(/^https?:\/\//, '');
  value = value.replace(/^www\./, '');
  const slash = value.indexOf('/');
  if (slash >= 0) value = value.slice(0, slash);
  const at = value.indexOf('@');
  if (at >= 0) value = value.slice(at + 1);
  // Reject obviously-invalid forms
  if (!/^[a-z0-9.\-]+$/.test(value)) throw new Error('Domain contains invalid characters');
  if (!value.includes('.')) throw new Error('Domain must include a TLD (e.g., example.com)');
  if (value.length > 253) throw new Error('Domain too long (max 253 chars)');
  // Reject IP literals — RDAP supports them but they're not domains in the usual sense
  if (/^\d+(\.\d+){3}$/.test(value)) throw new Error('Enter a domain, not an IP');
  return value;
}

// Extract registrable-name from RDAP vcard array (handles redaction)
function extractFromVcard(vcardArray) {
  // vCard is array form: ["vcard", [ ["version", {}, "text", "4.0"], ["fn", {}, "text", "Name"], ... ] ]
  if (!Array.isArray(vcardArray) || vcardArray.length < 2) return {};
  const items = vcardArray[1];
  const out = {};
  if (!Array.isArray(items)) return out;
  for (const item of items) {
    if (!Array.isArray(item) || item.length < 4) continue;
    const [name, , , value] = item;
    if (typeof name === 'string' && name.length > 0 && value && !isRedacted(value)) {
      out[name] = value;
    }
  }
  return out;
}

// Format a registrable object — return only the most useful fields
function formatResult(domain, rdap) {
  const events = Array.isArray(rdap.events) ? rdap.events : [];
  const event = (action) => {
    const e = events.find((x) => x.eventAction === action);
    return e?.eventDate || null;
  };

  const vcard = extractFromVcard(rdap.vcardArray);

  // Last RDAP error indicates "not found" — surface that
  const notFound = rdap.objectClassName === 'domain' &&
    rdap.status?.some((s) => s.includes('404')) ||
    rdap.errorCode === 404;

  return {
    domain,
    rdap_conformance: rdap.rdapConformance || [],
    status: rdap.status || [],
    public_id: rdap.publicId || null,
    registrar: {
      name: rdap.port43 || null,
      iana_id: rdap.publicId ? rdap.publicId.replace(/^IANA-/, '') : null,
      abuse_email: null, // populated from registry-level rdap when fetched
    },
    nameservers: (rdap.nameservers || []).map((ns) => ({
      ldap_name: ns.ldhName || ns.objectHandle || null,
      ip_v4: (ns.ipAddresses || [])
        .filter((ip) => ip.startsWith?.('v4'))
        .map((ip) => ip),
      ip_v6: (ns.ipAddresses || [])
        .filter((ip) => ip.startsWith?.('v6'))
        .map((ip) => ip),
    })),
    registrant: {
      name: vcard.fn || null,
      organization: vcard.org || null,
      email: vcard.email || null,
      phone: vcard.tel || null,
      address: [vcard['adr-street'], vcard['adr-locality'], vcard['adr-region'], vcard['adr-country']]
        .filter(Boolean)
        .join(', ') || null,
      country: vcard['adr-country'] || null,
    },
    dates: {
      registered: event('registration'),
      expires: event('expiration'),
      last_changed: event('last changed'),
      last_update_of_whois: event('last update of whois database'),
    },
    dnssec: {
      signed: rdap.secureDNS?.zoneSigned ?? rdap.secureDNS?.delegationSigned ?? null,
    },
    redacted: Object.keys(vcard).length === 0 || isRedacted(vcard.fn),
    cached: false,
  };
}

export async function onRequestGet(context) {
  const { request, data, env } = context;
  const url = new URL(request.url);
  const input = url.searchParams.get('domain') || url.searchParams.get('url');
  const plan = data?.user?.plan || 'free';

  if (!input) {
    return jsonResponse({
      error: 'invalid_request',
      message: 'Provide a domain. Example: /api/rdap?domain=example.com',
    }, 400);
  }

  let domain;
  try {
    domain = normalizeDomain(input);
  } catch (e) {
    return jsonResponse({ error: 'invalid_domain', message: e.message }, 400);
  }

  // KV cache: cheap domain lookups, 24h TTL
  const cache = caches.default;
  const cacheKeyReq = new Request(
    `https://cache.local/rdap?domain=${encodeURIComponent(domain)}`,
    { method: 'GET', headers: { 'Cache-Domain': domain } },
  );
  const cached = await cache.match(cacheKeyReq);
  if (cached) {
    const h = new Headers(cached.headers);
    h.set('X-Cache', 'HIT');
    return new Response(cached.body, { status: cached.status, headers: h });
  }

  // Fetch RDAP response
  let rdap;
  let fetchTimeMs = 0;
  try {
    const start = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
    const resp = await fetch(`${RDAP_ORG_URL}/domain/${domain}`, {
      headers: {
        'Accept': 'application/rdap+json, application/json',
        'User-Agent': BROWSER_UA,
      },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    fetchTimeMs = Date.now() - start;

    if (resp.status === 404) {
      return jsonResponse({
        error: 'not_found',
        message: 'Domain not found in any RDAP registry',
        domain,
        suggestion: 'Check spelling, or the TLD may not support RDAP',
      }, 404);
    }

    if (!resp.ok) {
      return jsonResponse({
        error: 'rdap_error',
        status: resp.status,
        message: `RDAP server returned HTTP ${resp.status}`,
        domain,
      }, 502);
    }

    // Cap response size — RDAP shouldn't be huge but cap anyway
    const cl = parseInt(resp.headers.get('content-length') || '0', 10);
    if (cl > MAX_TEXT_BYTES) {
      return jsonResponse({ error: 'response_too_large', message: 'RDAP response exceeded size limit' }, 502);
    }
    const text = await resp.text();
    if (text.length > MAX_TEXT_BYTES) {
      return jsonResponse({ error: 'response_too_large', actual_size: text.length }, 502);
    }
    rdap = JSON.parse(text);
  } catch (e) {
    return jsonResponse({
      error: 'rdap_failed',
      message: e.name === 'AbortError' ? 'RDAP lookup timed out' : e.message,
      domain,
    }, 502);
  }

  if (!rdap || rdap.errorCode) {
    return jsonResponse({
      error: 'rdap_error',
      message: rdap?.title || 'RDAP service returned no data',
      domain,
    }, 502);
  }

  const result = formatResult(domain, rdap);
  // Free tier: less detail
  if (plan === 'free') {
    result.registrant = { redacted: true };
    result.nameservers = result.nameservers.slice(0, 2); // limit to first 2
  }
  result.fetch_time_ms = fetchTimeMs;

  const responseBody = JSON.stringify({ success: true, data: result });
  const response = new Response(responseBody, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=300',
      'X-Cache': 'MISS',
      'X-Fetch-Time-Ms': String(fetchTimeMs),
    },
  });

  // Cache for 24h (domain data changes slowly)
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