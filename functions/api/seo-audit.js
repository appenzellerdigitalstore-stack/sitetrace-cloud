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
    this.viewport = null;
    this.favicon = [];
    this.hreflangs = [];
    this.og = {};
    this.twitterCard = {};
    this.lang = null;
    this.schemaTypes = [];
    this.h1 = [];
    this.h2 = [];
    this.h3 = [];
    this.h4 = [];
    this.h5 = [];
    this.h6 = [];
    this.images = { total: 0, missing_alt: 0, with_alt: 0, samples: [] };
    this.linksInternal = new Set();
    this.linksExternal = new Set();
    this.jsonLdParseErrors = 0;
  }

  // Collect all the things HTMLRewriter can extract in streaming fashion.
  // CF Workers HTMLRewriter does NOT support composing sub-rewriters via
  // `.on(otherRewriter)` — `.on()` only accepts a string selector + handlers.
  // The previous code chained sub-rewriters via `.on(htmlEls)` etc. which
  // threw at buildRewriter() time and surfaced as a 500 with error 1101.
  // Now we use a single HTMLRewriter with chained `.on(selector, handlers)`
  // calls, matching the pattern in schema-detector.js (which works).
  buildRewriter(baseHostname) {
    const self = this;
    const rw = new HTMLRewriter();

    // <html lang="...">
    rw.on('html', {
      element(el) {
        if (!self.lang) self.lang = el.getAttribute('lang') || null;
      },
    });

    // <title>
    rw.on('title', {
      text(t) {
        if (self.title === null) self.title = '';
        self.title += t.text;
      },
    });

    // <meta name="..."> + <meta property="..."> (description, keywords, robots,
    // viewport, og:*, twitter:*)
    rw.on('meta', {
      element(el) {
        const name = (el.getAttribute('name') || '').toLowerCase();
        const prop = (el.getAttribute('property') || '').toLowerCase();
        const content = el.getAttribute('content') || '';
        if (!content) return;
        if (name === 'description' && !self.metaDescription) self.metaDescription = content;
        else if (name === 'keywords' && !self.metaKeywords) self.metaKeywords = content;
        else if (name === 'robots' && !self.robotsMeta) self.robotsMeta = content;
        else if (name === 'viewport' && !self.viewport) self.viewport = content;
        else if (prop.startsWith('og:')) self.og[prop.slice(3)] = content;
        else if (prop.startsWith('twitter:') || name.startsWith('twitter:')) {
          self.twitterCard[prop.startsWith('twitter:') ? prop.slice(8) : name.slice(8)] = content;
        }
      },
    });

    // <link rel="icon"> and <link rel="...hreflang...">
    rw.on('link', {
      element(el) {
        const rel = (el.getAttribute('rel') || '').toLowerCase();
        const href = el.getAttribute('href') || '';
        if (!href) return;
        if (rel.includes('icon')) self.favicon.push(href);
        if (rel.includes('hreflang')) {
          const lang = el.getAttribute('hreflang') || '';
          if (lang) self.hreflangs.push(`${lang} → ${href}`);
        }
      },
    });

    // <link rel="canonical"> (separate selector so it wins over generic <link>)
    rw.on('link[rel="canonical"]', {
      element(el) {
        if (!self.canonical) self.canonical = el.getAttribute('href');
      },
    });

    // <script type="application/ld+json"> — accumulate text, parse on </script>
    rw.on('script[type="application/ld+json"]', {
      text(t) {
        self._jsonldBuffer = (self._jsonldBuffer || '') + t.text;
      },
      end() {
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

    // <img> — alt-text coverage
    rw.on('img', {
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

    // <a href="..."> — internal vs external link inventory
    rw.on('a[href]', {
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

    // Note: heading text is re-parsed via regex from the raw HTML after
    // the rewriter runs (extractHeadingsFromHTML below). HTMLRewriter's
    // text() callback fires per text-chunk, which doesn't accumulate well
    // across child elements (e.g. <h1><span>foo</span> bar</h1>).

    return rw;
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

  // ── Language ────────────────────────────────────────────────────────────
  if (data.lang) {
    passed.push(`Document language declared: ${data.lang}`);
  } else {
    warnings.push('No `<html lang="...">` attribute — not accessible, hurts SEO');
    score -= 2;
  }

  // ── Viewport meta (mobile-friendly) ─────────────────────────────────────
  if (data.viewport) {
    passed.push('Mobile viewport meta tag present');
  } else {
    warnings.push('No viewport meta tag — page not optimized for mobile');
    score -= 3;
  }

  // ── Doctype ────────────────────────────────────────────────────────────
  if (data.doctype === 'html5') {
    passed.push('HTML5 doctype declared');
  } else if (data.doctype === 'quirks_or_none') {
    warnings.push('Missing or non-HTML5 doctype — page may render in quirks mode');
    score -= 3;
  }

  // ── Favicon ────────────────────────────────────────────────────────────
  if (data.favicon && data.favicon.length > 0) {
    passed.push(`Favicon present (${data.favicon.length} link tag${data.favicon.length === 1 ? '' : 's'})`);
  } else {
    warnings.push('No `<link rel="icon">` — affects browser tab + SERP favicon');
    score -= 1;
  }

  // ── Robots meta ────────────────────────────────────────────────────────
  if (data.robotsMeta) {
    const lower = data.robotsMeta.toLowerCase();
    if (lower.includes('noindex')) {
      issues.push(`Meta robots: "${data.robotsMeta}" — page is excluded from search engines`);
      score -= 8;
    } else if (lower.includes('nofollow')) {
      warnings.push(`Meta robots: "${data.robotsMeta}" — links from this page won't pass equity`);
      score -= 2;
    } else {
      passed.push(`Meta robots: "${data.robotsMeta}"`);
    }
  } else {
    passed.push('Meta robots allows indexing');
  }

  // ── Open Graph completeness ─────────────────────────────────────────────
  const ogPresent = data.openGraph && Object.keys(data.openGraph).length > 0;
  const ogRequired = ['og:title', 'og:description', 'og:image', 'og:url'];
  const ogMissing = ogRequired.filter((k) => !data.openGraph[k]);
  if (!ogPresent) {
    warnings.push('No Open Graph tags — links will look plain when shared on social media');
    score -= 3;
  } else if (ogMissing.length > 0) {
    warnings.push(`Missing Open Graph tags: ${ogMissing.join(', ')}`);
    score -= Math.min(3, ogMissing.length);
  } else {
    passed.push('Open Graph tags complete (title, description, image, URL)');
  }

  // ── Twitter Card ───────────────────────────────────────────────────────
  const twitterTags = ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image'];
  const twitterMissing = twitterTags.filter((k) => !data.twitterCard[k]);
  if (data.twitterCard && Object.keys(data.twitterCard).length > 0) {
    if (twitterMissing.length === 0) {
      passed.push('Twitter Card tags complete');
    } else {
      warnings.push(`Twitter Card missing: ${twitterMissing.join(', ')}`);
      score -= 2;
    }
  } else {
    warnings.push('No Twitter Card tags — X/Twitter shares will use Open Graph only');
    score -= 1;
  }

  // ── Hreflang (internationalization) ────────────────────────────────────
  if (data.hreflangs && data.hreflangs.length > 0) {
    passed.push(`Hreflang declared: ${data.hreflangs.slice(0, 5).join(', ')}${data.hreflangs.length > 5 ? ` (+${data.hreflangs.length - 5} more)` : ''}`);
  }
  // Note: not penalizing absence — many sites are single-language

  // ── Content quality signals ─────────────────────────────────────────────
  if (data.wordCount < 100) {
    warnings.push(`Thin content (${data.wordCount} words — search engines prefer 300+ for ranking)`);
    score -= 5;
  } else if (data.wordCount < 300) {
    warnings.push(`Short content (${data.wordCount} words — aim for 300+ for competitive topics)`);
    score -= 2;
  } else {
    passed.push(`Content depth: ${data.wordCount} words`);
  }

  // ── HTML size sanity ──────────────────────────────────────────────────
  if (data.htmlSizeKb > 1000) {
    warnings.push(`Heavy HTML (${data.htmlSizeKb}KB) — consider minification or code-splitting`);
    score -= 2;
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
    await rewriter.transform(new Response(html)).arrayBuffer();
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
  // Doctype detection (simple regex on first 200 chars)
  const headSnippet = html.slice(0, 200).toLowerCase();
  const doctype = headSnippet.startsWith('<!doctype html>') || headSnippet.startsWith('<!doctype html ') ? 'html5'
                  : headSnippet.includes('<!doctype') ? 'quirks_or_none'
                  : null;

  const auditData = {
    url: urlObj.href,
    title: extractor.title?.trim() || null,
    lang: extractor.lang,
    viewport: extractor.viewport,
    doctype,
    favicon: extractor.favicon,
    hreflangs: extractor.hreflangs,
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
    twitterCard: extractor.twitterCard,
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
    lang: auditData.lang,
    doctype: auditData.doctype,
    meta_description: auditData.metaDescription,
    meta_description_length: auditData.metaDescription ? auditData.metaDescription.length : 0,
    canonical: auditData.canonical,
    robots_meta: auditData.robotsMeta,
    viewport: auditData.viewport ? '[present]' : null,
    favicon_count: auditData.favicon?.length || 0,
    hreflangs: auditData.hreflangs?.length || 0,
    headings: plan === 'free' ? { h1: auditData.headings.h1 } : auditData.headings,
    images: auditData.images,
    word_count: auditData.wordCount,
    ...(plan !== 'free' && {
      links: auditData.links,
      open_graph: auditData.openGraph,
      twitter_card: auditData.twitterCard,
      hreflangs_full: auditData.hreflangs,
      favicons: auditData.favicon,
      schema_types: auditData.schemaTypes,
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

// Dual-export: expose helpers for Node.js test runner
if (typeof module !== 'undefined') {
  module.exports = {
    scoresSEO,
    cacheKey,
    extractHeadingsFromHTML,
    extractBodyText,
    getKeywordDensity,
    MAX_HTML_BYTES,
    HeadExtractor,
  };
}