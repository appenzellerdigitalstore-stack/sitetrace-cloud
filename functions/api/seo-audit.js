// =====================================================================
// sitetrace-api — SEO Audit endpoint (Cloudflare Workers)
//
// Migrated from F:\.Projects\api-marketplace\seo-audit\index.js
//   - Removed cheerio dependency (Workers-incompatible)
//   - Removed axios (Workers has native fetch)
//   - POST → GET (so the edge cache can serve repeat requests)
//   - HTMLRewriter for streaming parsing of the head section
//   - regex/string parsing for body content (headings, images, links)
//
// Endpoint: GET /api/seo-audit?url=https://example.com
// Auth: shared middleware (functions/_middleware.js)
// Free tier: 100 calls/day per IP. Paid: 1k/30k/200k per the user's plan.
// =====================================================================

// ---------------------------------------------------------------------
// Defaults & limits
// ---------------------------------------------------------------------
const DEFAULT_TIMEOUT_MS = 15000;          // 15s — Workers CPU time limits
const MAX_HTML_BYTES = 5 * 1024 * 1024;     // 5 MB — refuse pages larger than this
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Stopwords for keyword density (same as the original)
const STOP_WORDS = new Set([
  'that','this','with','from','they','have','been','were','will','your',
  'more','also','than','then','when','what','there','their','about','which','would','could','should'
]);

const RICH_RESULT_TYPES = new Set([
  'Article','NewsArticle','BlogPosting','WebPage','WebSite',
  'Organization','LocalBusiness','Person','Product','Offer',
  'Review','AggregateRating','FAQPage','HowTo','Recipe',
  'Event','BreadcrumbList','SiteLinksSearchBox','VideoObject',
  'ImageObject','JobPosting','Course','Book','MusicAlbum',
  'SoftwareApplication','MedicalCondition'
]);

// ---------------------------------------------------------------------
// URL normalization + SSRF protection (matches the original behavior)
// ---------------------------------------------------------------------
function normalizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new Error('URL is required');
  }
  const value = rawUrl.trim();
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const parsed = new URL(withProtocol);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http/https URLs are supported');
  }
  const hostname = parsed.hostname.toLowerCase();
  // Block SSRF to internal IPs (Cloudflare also enforces egress filtering
  // at the platform level, but this is defense in depth)
  const blocked = ['localhost', '0.0.0.0', '127.0.0.1', '::1'];
  const privateRanges = [
    /^10\./, /^127\./, /^192\.168\./, /^169\.254\./,
    /^172\.(1[6-9]|2\d|3[0-1])\./,
  ];
  if (blocked.includes(hostname) || privateRanges.some((p) => p.test(hostname))) {
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

// ---------------------------------------------------------------------
// HTMLRewriter-based head extraction (streaming, fast, no DOM in memory)
// ---------------------------------------------------------------------
class HeadExtractor {
  constructor() {
    this.title = null;
    this.metaDescription = null;
    this.metaKeywords = null;
    this.canonical = null;
    this.robotsMeta = null;
    this.og = {};
    this.schemaTypes = [];
    this.h1 = []; h2 = []; h3 = []; h4 = []; h5 = []; h6 = [];
    this.images = { total: 0, missing_alt: 0, with_alt: 0, samples: [] };
    this.linksInternal = new Set();
    this.linksExternal = new Set();
    this.jsonLdParseErrors = 0;
  }

  // Collect all the things HTMLRewriter can extract in streaming fashion
  buildRewriter(baseHostname) {
    const self = this;

    // Title
    const titleEl = new HTMLRewriter()
      .on('title', {
        text(t) {
          if (self.title === null) self.title = '';
          self.title += t.text;
        },
      });

    // Meta tags
    const metaEls = new HTMLRewriter()
      .on('meta', {
        element(el) {
          const name = (el.getAttribute('name') || '').toLowerCase();
          const prop = (el.getAttribute('property') || '').toLowerCase();
          const content = el.getAttribute('content') || '';
          if (!content) return;
          if (name === 'description' && !self.metaDescription) self.metaDescription = content;
          else if (name === 'keywords' && !self.metaKeywords) self.metaKeywords = content;
          else if (name === 'robots' && !self.robotsMeta) self.robotsMeta = content;
          else if (prop.startsWith('og:')) self.og[prop.slice(3)] = content;
        },
      });

    // Canonical link
    const canonicalEl = new HTMLRewriter()
      .on('link[rel="canonical"]', {
        element(el) {
          if (!self.canonical) self.canonical = el.getAttribute('href');
        },
      });

    // JSON-LD schema
    const jsonLdEl = new HTMLRewriter()
      .on('script[type="application/ld+json"]', {
        text(t) {
          // Accumulate text until end tag; we'll parse on done
          self._jsonldBuffer = (self._jsonldBuffer || '') + t.text;
        },
        end(end) {
          if (!self._jsonldBuffer) return;
          try {
            const parsed = JSON.parse(self._jsonldBuffer);
            const items = Array.isArray(parsed) ? parsed : [parsed];
            for (const item of items) {
              const type = item['@type'] || (Array.isArray(item['@type']) ? item['@type'][0] : null);
              if (type) self.schemaTypes.push(type);
            }
          } catch (_) {
            self.jsonLdParseErrors += 1;
          }
          self._jsonldBuffer = '';
        },
      });

    // Headings
    const headings = { h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h5', h6: 'h6' };
    const headingEls = new HTMLRewriter();
    for (const [key, tag] of Object.entries(headings)) {
      headingEls.on(tag, {
        text(t) {
          self[key] = self[key] || [];
          if (self[key].length < 1) {
            const last = self[key][self[key].length - 1];
            self[key][self[key].length - 1] = (last || '') + t.text;
          }
        },
        element(el) {
          if (!self[key]) self[key] = [];
        },
      });
    }
    // The heading text capture above isn't quite right for streaming
    // (each text() call is per-chunk). We re-parse headings from the
    // body HTML after rewriter runs (cheerio-equivalent via regex below).

    // Images + links — collected by HTMLRewriter for accurate attribute reads
    const imageEls = new HTMLRewriter()
      .on('img', {
        element(el) {
          self.images.total += 1;
          const alt = el.getAttribute('alt');
          if (alt && alt.trim() !== '') {
            self.images.with_alt += 1;
          } else {
            self.images.missing_alt += 1;
            if (self.images.samples.length < 5) {
              self.images.samples.push({ src: el.getAttribute('src') || null, alt: null });
            }
          }
        },
      });

    const linkEls = new HTMLRewriter()
      .on('a[href]', {
        element(el) {
          const href = el.getAttribute('href') || '';
          if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
          try {
            const resolved = new URL(href, baseHostname);
            if (resolved.hostname === new URL(baseHostname).hostname) {
              self.linksInternal.add(resolved.href);
            } else {
              self.linksExternal.add(resolved.href);
            }
          } catch (_) { /* skip invalid hrefs */ }
        },
      });

    // Chain all rewriters together
    return titleEl.on(metaEls)
      .on(canonicalEl)
      .on(jsonLdEl)
      .on(headingEls)
      .on(imageEls)
      .on(linkEls);
  }
}

// ---------------------------------------------------------------------
// Fallback regex parsing for things HTMLRewriter can't stream reliably
// (heading text extraction, body text for keyword density)
// ---------------------------------------------------------------------
function extractHeadingsFromHTML(html) {
  const out = { h1: [], h2: [], h3: [], h4: [], h5: [], h6: [] };
  const re = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const level = parseInt(m[1], 10);
    const text = m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (text) out[`h${level}`].push(text);
  }
  return out;
}

function extractBodyText(html) {
  // Strip script/style/noscript first
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  // Then strip remaining tags
  return stripped.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function getKeywordDensity(text, topN = 10) {
  const words = text.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3);
  const freq = {};
  for (const w of words) {
    if (STOP_WORDS.has(w)) continue;
    freq[w] = (freq[w] || 0) + 1;
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([word, count]) => ({
      word,
      count,
      density: `${((count / words.length) * 100).toFixed(2)}%`,
    }));
}

// ---------------------------------------------------------------------
// Scoring (matches original api-marketplace logic)
// ---------------------------------------------------------------------
function scoresSEO(data) {
  let score = 100;
  const issues = [];
  const warnings = [];
  const passed = [];

  // Title checks
  if (!data.title) {
    score -= 15;
    issues.push('Missing page title');
  } else if (data.title.length < 30) {
    score -= 5;
    warnings.push(`Title is short (${data.title.length} chars, recommended 50–60)`);
  } else if (data.title.length > 60) {
    score -= 3;
    warnings.push(`Title is long (${data.title.length} chars, recommended 50–60)`);
  } else {
    passed.push('Title length is optimal');
  }

  // Meta description
  if (!data.metaDescription) {
    score -= 10;
    issues.push('Missing meta description');
  } else if (data.metaDescription.length < 70) {
    score -= 5;
    warnings.push('Meta description is too short');
  } else if (data.metaDescription.length > 160) {
    score -= 3;
    warnings.push('Meta description is too long (>160 chars)');
  } else {
    passed.push('Meta description length is optimal');
  }

  // H1
  if (!data.headings.h1 || data.headings.h1.length === 0) {
    score -= 10;
    issues.push('Missing H1 tag');
  } else if (data.headings.h1.length > 1) {
    score -= 5;
    warnings.push(`Multiple H1 tags found (${data.headings.h1.length})`);
  } else {
    passed.push('Single H1 tag present');
  }

  // Images
  if (data.images.missing_alt > 0) {
    score -= Math.min(10, data.images.missing_alt * 2);
    warnings.push(`${data.images.missing_alt} images missing alt text`);
  } else if (data.images.total > 0) {
    passed.push('All images have alt text');
  }

  // Canonical
  if (!data.canonical) {
    score -= 5;
    warnings.push('No canonical URL specified');
  } else {
    passed.push('Canonical URL is set');
  }

  // Schema
  if (data.schemaTypes.length === 0) {
    warnings.push('No structured data (schema.org) found');
    score -= 5;
  } else {
    passed.push(`Structured data found: ${data.schemaTypes.join(', ')}`);
  }

  // HTTPS
  if (!data.url.startsWith('https')) {
    score -= 10;
    issues.push('Page not served over HTTPS');
  } else {
    passed.push('HTTPS is enabled');
  }

  const grade =
    score >= 90 ? 'A' :
    score >= 75 ? 'B' :
    score >= 60 ? 'C' :
    score >= 45 ? 'D' : 'F';

  return {
    score: Math.max(0, score),
    grade,
    issues,
    warnings,
    passed,
  };
}

// ---------------------------------------------------------------------
// Edge cache helpers
// ---------------------------------------------------------------------
function cacheKey(request) {
  // Cache key includes only the URL param, not auth headers (so cache is shared)
  const url = new URL(request.url);
  const target = url.searchParams.get('url') || '';
  return new Request(`https://cache.local/seo-audit?url=${encodeURIComponent(target)}`, {
    method: 'GET',
    headers: { 'Cache-Target': target },
  });
}

// ---------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------
export async function onRequestGet(context) {
  const { request, env, data } = context;
  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url');
  const plan = data?.user?.plan || (data?.free ? 'free' : 'free');

  if (!targetUrl) {
    return jsonResponse({
      error: 'invalid_request',
      message: 'Provide a valid URL. Example: /api/seo-audit?url=https://example.com',
    }, 400);
  }

  let urlObj;
  try {
    urlObj = normalizeUrl(targetUrl);
  } catch (e) {
    return jsonResponse({ error: 'invalid_url', message: e.message }, 400);
  }

  // Edge cache check — same URL within 5 min returns cached result
  const cacheKeyReq = cacheKey(request);
  const cache = caches.default;
  const cached = await cache.match(cacheKeyReq);
  if (cached) {
    const h = new Headers(cached.headers);
    h.set('X-Cache', 'HIT');
    return new Response(cached.body, { status: cached.status, headers: h });
  }

  // Fetch the target URL with realistic browser UA
  let html;
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

    if (!resp.ok) {
      return jsonResponse({
        error: 'fetch_failed',
        status: resp.status,
        message: `Target URL returned HTTP ${resp.status}`,
        url: urlObj.href,
      }, 502);
    }

    // Check content-length before downloading
    const contentLength = parseInt(resp.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_HTML_BYTES) {
      return jsonResponse({
        error: 'page_too_large',
        message: `Page exceeds ${MAX_HTML_BYTES} bytes; refusing to process`,
        content_length: contentLength,
      }, 413);
    }

    html = await resp.text();
    if (html.length > MAX_HTML_BYTES) {
      return jsonResponse({
        error: 'page_too_large',
        message: `Downloaded HTML exceeds ${MAX_HTML_BYTES} bytes`,
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

  // Parse with HTMLRewriter (streaming) for head + structural data — single pass
  const extractor = new HeadExtractor();
  const rewriter = extractor.buildRewriter(urlObj.href);
  try {
    await new Response(html).body
      .pipeThrough(new HTMLRewriter().transform(rewriter))
      .arrayBuffer();
  } catch (e) {
    // HTMLRewriter failures are non-fatal — regex fallbacks below still work
    console.error('HTMLRewriter failed:', e?.message || e);
  }

  // Headings need a separate pass — HTMLRewriter text() doesn't accumulate well
  const headings = extractHeadingsFromHTML(html);

  // Body text for word count + keyword density
  const bodyText = extractBodyText(html);
  const wordCount = bodyText.split(/\s+/).filter(Boolean).length;

  // Assemble the audit data
  const auditData = {
    url: urlObj.href,
    title: extractor.title?.trim() || null,
    metaDescription: extractor.metaDescription,
    metaKeywords: extractor.metaKeywords,
    canonical: extractor.canonical,
    robotsMeta: extractor.robotsMeta,
    headings,
    images: {
      ...extractor.images,
      alt_coverage: extractor.images.total > 0
        ? `${Math.round((extractor.images.with_alt / extractor.images.total) * 100)}%`
        : 'N/A',
    },
    links: {
      internal_count: extractor.linksInternal.size,
      external_count: extractor.linksExternal.size,
      internal_sample: [...extractor.linksInternal].slice(0, 10),
      external_sample: [...extractor.linksExternal].slice(0, 10),
    },
    openGraph: extractor.og,
    schemaTypes: [...new Set(extractor.schemaTypes)],
    schemaParseErrors: extractor.jsonLdParseErrors,
    wordCount,
    fetchTimeMs,
    htmlSizeKb: Math.round(html.length / 1024),
  };

  const audit = scoresSEO(auditData);

  // Plan-based filtering (matches original behavior)
  const result = {
    url: auditData.url,
    seo_score: audit.score,
    grade: audit.grade,
    issues: audit.issues,
    warnings: audit.warnings,
    passed: audit.passed,
    title: auditData.title,
    title_length: auditData.title ? auditData.title.length : 0,
    meta_description: auditData.metaDescription,
    meta_description_length: auditData.metaDescription ? auditData.metaDescription.length : 0,
    canonical: auditData.canonical,
    headings: plan === 'free' ? { h1: auditData.headings.h1 } : auditData.headings,
    images: auditData.images,
    word_count: auditData.wordCount,
    ...(plan !== 'free' && {
      links: auditData.links,
      open_graph: auditData.openGraph,
      schema_types: auditData.schemaTypes,
      robots_meta: auditData.robotsMeta,
      meta_keywords: auditData.metaKeywords,
      fetch_time_ms: auditData.fetchTimeMs,
      html_size_kb: auditData.htmlSizeKb,
      schema_parse_errors: auditData.schemaParseErrors,
    }),
    ...((plan === 'ultra' || plan === 'mega') && {
      keyword_density: getKeywordDensity(bodyText),
    }),
    plan,
  };

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

  // Cache for 5 minutes at the edge
  try {
    await cache.put(cacheKeyReq, response.clone());
  } catch (_) { /* cache write is best-effort */ }

  return response;
}

// OPTIONS handler for CORS preflight (mirrors the middleware)
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