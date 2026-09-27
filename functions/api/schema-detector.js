// =====================================================================
// sitetrace-api — Schema Detector endpoint (Cloudflare Workers)
//
// Migrated from F:\.Projects\api-marketplace\schema-detector\index.js
//   - Removed cheerio (Workers-incompatible)
//   - Removed express (Workers handlers = onRequestGet/onRequestPost)
//   - POST → GET (enables edge cache, cache-friendly URLs)
//   - JSON-LD extracted via streaming HTMLRewriter (cheerio-equivalent)
//   - Microdata extracted via regex (cheerio DOM walking not portable)
//   - Same plan-based filtering preserved
//
// Endpoint: GET /api/schema-detector?url=https://example.com
// Auth: shared middleware (functions/_middleware.js)
// =====================================================================

const RICH_RESULT_TYPES = [
  'Article', 'NewsArticle', 'BlogPosting', 'WebPage', 'WebSite',
  'Organization', 'LocalBusiness', 'Person', 'Product', 'Offer',
  'Review', 'AggregateRating', 'FAQPage', 'HowTo', 'Recipe',
  'Event', 'BreadcrumbList', 'SiteLinksSearchBox', 'VideoObject',
  'ImageObject', 'JobPosting', 'Course', 'Book', 'MusicAlbum',
  'SoftwareApplication', 'MedicalCondition',
];

// ---------------------------------------------------------------------
// Limits (cheerio + express defaults lifted; tightened for Workers)
// ---------------------------------------------------------------------
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ---------------------------------------------------------------------
// URL normalization + JSON helpers (matches sitetrace-api convention)
// ---------------------------------------------------------------------

function normalizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') throw new Error('URL is required');
  const value = rawUrl.trim();
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const parsed = new URL(withProtocol);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http/https URLs');
  const hostname = parsed.hostname.toLowerCase();
  if (['localhost', '0.0.0.0', '127.0.0.1', '::1'].includes(hostname)) {
    throw new Error('Private/local network URLs are not supported');
  }
  return parsed;
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

function planMaxBytes(plan) {
  switch (plan) {
    case 'mega':
    case 'ultra': return MAX_HTML_BYTES;
    case 'pro':    return 2 * 1024 * 1024;
    case 'free':
    default:        return 1024 * 1024; // 1 MB on free
  }
}

// ---------------------------------------------------------------------
// JSON-LD extraction via streaming HTMLRewriter
// (cheerio equivalent — same logic, no DOM in memory)
// ---------------------------------------------------------------------

class JsonLdExtractor {
  constructor() {
    this.blocks = [];
    this.buffer = '';
    this.inJsonLd = false;
  }
}

// HTMLRewriter build of the extractor (one streaming pass)
function buildJsonLdRewriter(ext) {
  return new HTMLRewriter().on('script[type="application/ld+json"]', {
    text(chunk) {
      ext.buffer += chunk.text;
    },
    end() {
      if (!ext.buffer.trim()) return;
      try {
        const parsed = JSON.parse(ext.buffer);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          ext.blocks.push({
            format: 'JSON-LD',
            type: item['@type'] || null,
            context: item['@context'] || null,
            data: item,
          });
        }
      } catch (e) {
        ext.blocks.push({
          format: 'JSON-LD',
          type: null,
          parse_error: e.message,
          raw: ext.buffer.slice(0, 200),
        });
      }
      ext.buffer = '';
    },
  });
}

// ---------------------------------------------------------------------
// Microdata extraction via regex
// (cheerio-style DOM walking isn't portable to Workers; we trade
//  precision for streaming-friendliness. JSON-LD covers ~90% of real
//  sites. Microdata coverage good enough for diagnostics.)
// ---------------------------------------------------------------------

function extractMicrodata(html) {
  const results = [];
  // Match each <tag ... itemscope ... itemtype="...">...</tag>
  // Use [\s\S] greedy to handle nested descendants (false positives OK
  // because we extract just the itemprops inside)
  const scopeRe = /<(\w+)([^>]*itemscope\b[^>]*itemtype=["']?([^"'\s>]+)["']?[^>]*)>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = scopeRe.exec(html)) !== null) {
    const tag = m[1];
    const itemType = m[3];
    const inner = m[4];
    const props = {};
    const propRe = /<(\w+)([^>]*itemprop=["']?([^"'\s>]+)["']?[^>]*)>([\s\S]*?)<\/\1>/gi;
    let pm;
    while ((pm = propRe.exec(inner)) !== null) {
      const propName = pm[3];
      // Prefer content= attribute, then href=, then text
      const contentMatch = pm[2].match(/content=["']([^"']*)["']/i);
      const hrefMatch    = pm[2].match(/href=["']([^"']*)["']/i);
      let value = contentMatch?.[1] || hrefMatch?.[1] || pm[4].replace(/<[^>]+>/g, '').trim();
      if (value && propName) {
        // Take first occurrence only
        if (!(propName in props)) props[propName] = value;
      }
    }
    // Skip empty itemscopes (false positive — inner had no itemprop)
    if (Object.keys(props).length > 0) {
      results.push({ format: 'Microdata', type: itemType, properties: props });
    }
  }
  return results;
}

// ---------------------------------------------------------------------
// Insight generation (verbatim port of original logic)
// ---------------------------------------------------------------------

function buildInsights(allSchemas, jsonLd, richResultEligible) {
  const insights = [];
  if (allSchemas.length === 0) {
    insights.push({
      type: 'warning',
      message: 'No structured data found — add JSON-LD to unlock Google rich results',
    });
  } else {
    insights.push({
      type: 'pass',
      message: `${allSchemas.length} schema block(s) detected`,
    });
  }
  if (richResultEligible.length > 0) {
    insights.push({
      type: 'pass',
      message: `Rich result eligible types: ${richResultEligible.join(', ')}`,
    });
  }
  const parseErrors = jsonLd.filter((s) => s.parse_error);
  if (parseErrors.length > 0) {
    insights.push({
      type: 'fail',
      message: `${parseErrors.length} JSON-LD block(s) failed to parse — fix syntax errors immediately`,
    });
  }
  const faq = jsonLd.find((s) => s.type === 'FAQPage');
  if (faq) {
    const questions = faq.data?.mainEntity ? faq.data.mainEntity : [];
    insights.push({
      type: 'info',
      message: `FAQPage schema found with ${questions.length} question(s)`,
    });
  }
  if (allSchemas.length > 0 && richResultEligible.length === 0) {
    insights.push({
      type: 'warning',
      message:
        'Schema types found but none are Google rich result eligible — ' +
        'consider adding Product, Article, FAQPage, or Organization',
    });
  }
  return insights;
}

// ---------------------------------------------------------------------
// Plan-based filter (matches original behavior)
// ---------------------------------------------------------------------

function filterByPlan(plan, data) {
  const out = {
    success: true,
    url: data.url,
    analyzed_at: data.analyzed_at,
    schema_count: data.schema_count,
    detected_types: data.detected_types,
    rich_result_eligible: data.rich_result_eligible,
    insights: data.insights,
    plan,
  };
  // Pro+ gets microdata + schema details
  if (plan !== 'free') {
    out.status_code = data.status_code;
    out.schemas = data.schemas.map((s) => {
      if (s.format !== 'JSON-LD') return s; // microdata always included
      // Free tier gets just count + types, Pro+ gets full data
      const truncated = { format: s.format, type: s.type };
      if (!s.parse_error) truncated.context = s.context;
      return truncated;
    });
  }
  if (plan === 'ultra' || plan === 'mega') {
    // Full data for everyone in ultra/mega (override truncation above)
    out.schemas = data.schemas;
  }
  return out;
}

// ---------------------------------------------------------------------
// Edge cache helpers (cache-friendly: same URL = same result)
// ---------------------------------------------------------------------

function cacheKey(request) {
  const url = new URL(request.url);
  const target = url.searchParams.get('url') || '';
  return new Request(
    `https://cache.local/schema-detector?url=${encodeURIComponent(target)}`,
    { method: 'GET', headers: { 'Cache-Target': target } },
  );
}

// ---------------------------------------------------------------------
// Main handler — GET (enables edge cache)
// ---------------------------------------------------------------------

export async function onRequestGet(context) {
  const { request, data } = context;
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url');
  const plan = data?.user?.plan || 'free';

  if (!targetUrl) {
    return jsonResponse({
      error: 'invalid_request',
      message: 'Provide a valid URL. Example: /api/schema-detector?url=https://example.com',
    }, 400);
  }

  let urlObj;
  try {
    urlObj = normalizeUrl(targetUrl);
  } catch (e) {
    return jsonResponse({ error: 'invalid_url', message: e.message }, 400);
  }

  // Edge cache check (5 min TTL — schema rarely changes minute-by-minute)
  const cacheKeyReq = cacheKey(request);
  const cache = caches.default;
  const cached = await cache.match(cacheKeyReq);
  if (cached) {
    const h = new Headers(cached.headers);
    h.set('X-Cache', 'HIT');
    return new Response(cached.body, { status: cached.status, headers: h });
  }

  // Fetch target URL
  let html;
  let statusCode = 0;
  let fetchTimeMs = 0;
  try {
    const start = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
    const resp = await fetch(urlObj.href, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    fetchTimeMs = Date.now() - start;
    statusCode = resp.status;

    if (!resp.ok) {
      return jsonResponse({
        error: 'fetch_failed',
        status: resp.status,
        message: `Target URL returned HTTP ${resp.status}`,
        url: urlObj.href,
      }, 502);
    }

    // Plan-based HTML cap
    const maxBytes = planMaxBytes(plan);
    const cl = parseInt(resp.headers.get('content-length') || '0', 10);
    if (cl > maxBytes) {
      return jsonResponse({
        error: 'page_too_large',
        message: `Page exceeds ${maxBytes} bytes for ${plan} plan`,
        content_length: cl,
      }, 413);
    }
    html = await resp.text();
    if (html.length > maxBytes) {
      return jsonResponse({
        error: 'page_too_large',
        message: `Downloaded HTML exceeds ${maxBytes} bytes`,
        actual_size: html.length,
      }, 413);
    }
  } catch (e) {
    return jsonResponse({
      error: 'fetch_failed',
      message: e.name === 'AbortError' ? 'Timeout fetching target URL (15s limit)' : e.message,
      url: urlObj.href,
    }, 502);
  }

  // Extract JSON-LD via HTMLRewriter (streaming, fast)
  const jsonLdExtractor = new JsonLdExtractor();
  try {
    await new Response(html).body
      .pipeThrough(buildJsonLdRewriter(jsonLdExtractor))
      .arrayBuffer();
  } catch (e) {
    // HTMLRewriter failures non-fatal — fall back to regex
    console.error('HTMLRewriter failed:', e?.message || e);
  }
  // Fallback: regex extract if HTMLRewriter missed anything
  if (jsonLdExtractor.blocks.length === 0) {
    const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const raw = m[1].trim();
      try {
        const parsed = JSON.parse(raw);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          jsonLdExtractor.blocks.push({
            format: 'JSON-LD',
            type: item['@type'] || null,
            context: item['@context'] || null,
            data: item,
          });
        }
      } catch (e) {
        jsonLdExtractor.blocks.push({
          format: 'JSON-LD',
          type: null,
          parse_error: e.message,
          raw: raw.slice(0, 200),
        });
      }
    }
  }
  const jsonLd = jsonLdExtractor.blocks;

  // Extract Microdata via regex
  const microdata = extractMicrodata(html);

  const allSchemas = [...jsonLd, ...microdata];
  const detectedTypes = [...new Set(allSchemas.map((s) => s.type).filter(Boolean))];
  const richResultEligible = detectedTypes.filter((t) =>
    RICH_RESULT_TYPES.some((r) => t === r || t.includes(r)),
  );
  const insights = buildInsights(allSchemas, jsonLd, richResultEligible);

  const full = {
    success: true,
    url: urlObj.href,
    status_code: statusCode,
    schema_count: allSchemas.length,
    detected_types: detectedTypes,
    rich_result_eligible: richResultEligible,
    schemas: allSchemas,
    insights,
    analyzed_at: new Date().toISOString(),
    fetch_time_ms: fetchTimeMs,
  };

  const result = filterByPlan(plan, full);

  const responseBody = JSON.stringify(result);
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

  // Cache for 5 minutes at the edge
  try {
    await cache.put(cacheKeyReq, response.clone());
  } catch (_) { /* best-effort */ }

  return response;
}

// OPTIONS handler for CORS preflight
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