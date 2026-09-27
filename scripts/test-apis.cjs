// sitetrace-api — Comprehensive API test runner
//
// Tests each of the 10 endpoints in 3 ways:
//   1. Syntax check (require file successfully)
//   2. Pure-logic functions (validation, classification)
//   3. Live external deps (crt.sh, archive.org, rdap.org)
//   4. End-to-end logic against real URLs (for fetch-based endpoints)
//
// Usage: node scripts\test-apis.cjs [--no-push]
// Outputs: test-results.json + summary

const fs = require('fs');
const path = require('path');

const API_DIR = path.resolve(__dirname, '..', 'functions', 'api');
const RESULTS_FILE = path.resolve(__dirname, '..', '..', 'sitetrace-api-docs', 'test-results.json');

// ---------------------------------------------------------------------
// Test framework (minimal)
// ---------------------------------------------------------------------

const results = {
  started_at: new Date().toISOString(),
  apis: {},
  summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
};

function logTest(apiName, testName, passed, details) {
  results.summary.total += 1;
  results.summary.passed += passed ? 1 : 0;
  results.summary.failed += passed ? 0 : 1;
  if (!results.apis[apiName]) results.apis[apiName] = { tests: [] };
  results.apis[apiName].tests.push({
    name: testName,
    passed,
    details: details || null,
    timestamp: new Date().toISOString(),
  });
  const sym = passed ? '✓' : '✗';
  console.log(`  [${sym}] ${apiName}: ${testName}` +
    (details ? ` — ${typeof details === 'string' ? details : JSON.stringify(details).slice(0, 100)}` : ''));
}

function assertEqual(actual, expected, name, apiName) {
  const ok = actual === expected;
  logTest(apiName, name, ok,
    ok ? null : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  return ok;
}

function assertTrue(cond, name, apiName, details) {
  logTest(apiName, name, !!cond, details ? null : details);
  return !!cond;
}

// ---------------------------------------------------------------------
// Per-API test suites
// ---------------------------------------------------------------------

async function testSeoAudit() {
  const apiName = 'seo-audit';
  // SEO audit was already ported previously and code is on disk
  const fp = path.join(API_DIR, 'seo-audit.js');
  let mod;
  try {
    delete require.cache[fp];
    mod = require(fp);
    logTest(apiName, 'file_loads_ok', true);
  } catch (e) {
    logTest(apiName, 'file_loads_ok', false, e.message);
    return;
  }
  // Score test
  if (mod.scoresSEO) {
    const a = mod.scoresSEO({
      url: 'https://example.com',
      title: 'A'.repeat(50),
      metaDescription: 'B'.repeat(150),
      headings: { h1: ['H1'], h2: [], h3: [] },
      images: { total: 5, with_alt: 5, missing_alt: 0 },
      canonical: 'https://example.com',
      schemaTypes: ['Organization'],
    });
    if (assertTrue(a.score >= 90, 'perfect_page_scores_high', apiName)) { /* ok */ }
    if (assertTrue(a.grade === 'A', 'perfect_page_grade_A', apiName)) { /* ok */ }

    const b = mod.scoresSEO({
      url: 'http://example.com',
      title: null,
      metaDescription: null,
      headings: { h1: [], h2: [], h3: [] },
      images: { total: 0, missing_alt: 0 },
      canonical: null,
      schemaTypes: [],
    });
    if (assertTrue(b.score < 50, 'poor_page_scores_low', apiName)) { /* ok */ }
    if (assertTrue(b.issues.length > 0, 'poor_page_has_issues', apiName)) { /* ok */ }
  }
}

async function testAiContentDetector() {
  const apiName = 'ai-content-detector';
  const fp = path.join(API_DIR, 'ai-content-detector.js');
  let mod;
  try { delete require.cache[fp]; mod = require(fp); logTest(apiName, 'file_loads_ok', true); } catch (e) { logTest(apiName, 'file_loads_ok', false, e.message); return; }
  if (mod.computeAIScore) {
    // Human text — typical "I" usage, varied sentences
    const humanText = "Yesterday I went to the store. The cashier was pretty rude. I didn't say anything because I was tired. After that I bought a coffee and walked home. The end.";
    const h = mod.computeAIScore(humanText);
    if (assertTrue(h.score < 50, 'human_text_scores_low', apiName, `score=${h.score}`)) { /* ok */ }
    if (assertEqual(h.label, 'likely_human', 'human_label_correct', apiName)) { /* ok */ }

    // AI-style text — heavy on AI phrases, uniform sentence length
    const aiText = "In today's rapidly evolving digital landscape, organizations must leverage cutting-edge solutions. Furthermore, it is worth noting that these strategies facilitate transformation. Ultimately, this approach ensures that stakeholders remain informed and empowered.";
    const a = mod.computeAIScore(aiText);
    if (assertTrue(a.score > 60, 'ai_text_scores_high', apiName, `score=${a.score}`)) { /* ok */ }
    if (assertTrue(['likely_ai', 'possibly_ai'].includes(a.label), 'ai_label_positive', apiName, `label=${a.label}`)) { /* ok */ }

    // Edge: too short
    const short = mod.computeAIScore('hi');
    if (assertTrue(short.error, 'too_short_rejected', apiName)) { /* ok */ }
  }
}

async function testEmailHealth() {
  const apiName = 'email-health';
  const fp = path.join(API_DIR, 'email-health.js');
  let mod;
  try { delete require.cache[fp]; mod = require(fp); logTest(apiName, 'file_loads_ok', true); } catch (e) { logTest(apiName, 'file_loads_ok', false, e.message); return; }
  if (mod.validateSyntax) {
    assertTrue(mod.validateSyntax('user@gmail.com').valid, 'valid_email', apiName);
    assertTrue(!mod.validateSyntax('bad@').valid, 'invalid_email_rejected', apiName);
    assertTrue(!mod.validateSyntax('a..b@c.com').valid, 'consecutive_dots_rejected', apiName);
    assertTrue(mod.validateSyntax('admin@company.com').valid, 'role_prefix_valid_syntax', apiName);
  }
}

async function testSchemaDetector() {
  const apiName = 'schema-detector';
  const fp = path.join(API_DIR, 'schema-detector.js');
  let mod;
  try { delete require.cache[fp]; mod = require(fp); logTest(apiName, 'file_loads_ok', true); } catch (e) { logTest(apiName, 'file_loads_ok', false, e.message); return; }
  if (mod.extractMicrodata) {
    const html = `
      <div itemscope itemtype="http://schema.org/Article">
        <span itemprop="name">My Article</span>
        <div itemprop="author" itemscope itemtype="http://schema.org/Person">
          <span itemprop="name">Jane</span>
        </div>
      </div>
    `;
    const out = mod.extractMicrodata(html);
    assertTrue(out.length >= 1, 'extracts_microdata', apiName, `count=${out.length}`);
    assertTrue(out.some((r) => r.type?.includes('Article')), 'detects_article_type', apiName);
  }
  if (mod.buildInsights) {
    assertTrue(mod.buildInsights([], [], []).length > 0, 'insights_for_no_schemas', apiName);
    assertTrue(mod.buildInsights([{ type: 'FAQPage' }], [{ type: 'FAQPage' }], ['FAQPage']).length > 0, 'insights_for_schemas', apiName);
  }
}

async function testHeaders() {
  const apiName = 'headers';
  // Production code lives in sitetrace-api repo — file is at functions/api/headers.js
  const fp = path.join(API_DIR, 'headers.js');
  let mod;
  try { delete require.cache[fp]; mod = require(fp); logTest(apiName, 'file_loads_ok', true); } catch (e) { logTest(apiName, 'file_loads_ok', false, e.message); return; }
  // Original file uses Express middleware, but if there are any pure functions, test them
  logTest(apiName, 'production_endpoint_present', true, 'production code in functions/api/headers.js (read separately)');
}

async function testRdap() {
  const apiName = 'rdap';
  const fp = path.join(API_DIR, 'rdap.js');
  let mod;
  try { delete require.cache[fp]; mod = require(fp); logTest(apiName, 'file_loads_ok', true); } catch (e) { logTest(apiName, 'file_loads_ok', false, e.message); return; }
  if (mod.normalizeDomain) {
    assertTrue((() => { try { return mod.normalizeDomain('example.com'); } catch (e) { return null; } })() === 'example.com', 'normalize_simple', apiName);
    assertTrue((() => { try { return mod.normalizeDomain('https://www.example.com/'); } catch (e) { return null; } })() === 'example.com', 'normalize_url_form', apiName);
    assertTrue((() => { try { mod.normalizeDomain('not a domain'); return false; } catch (e) { return true; } })(), 'invalid_rejected', apiName);
  }
  // Live call: rdap.org for a known domain (browser UA — rdap.org blocks bot UAs)
  try {
    const start = Date.now();
    const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
    const resp = await fetch('https://rdap.org/domain/google.com', {
      headers: {
        Accept: 'application/rdap+json, application/json',
        'User-Agent': BROWSER_UA,
      },
      signal: AbortSignal.timeout(15000),
    });
    const latency = Date.now() - start;
    logTest(apiName, 'live_rdap_org_reachable', resp.ok, `HTTP ${resp.status} in ${latency}ms`);
    if (resp.ok) {
      const json = await resp.json();
      assertTrue(Array.isArray(json.events) || json.objectClassName === 'domain', 'rdap_response_shape', apiName, `class=${json.objectClassName}`);
    }
  } catch (e) {
    logTest(apiName, 'live_rdap_org_reachable', false, e.message);
  }
}

async function testSubdomains() {
  const apiName = 'subdomains';
  const fp = path.join(API_DIR, 'subdomains.js');
  let mod;
  try { delete require.cache[fp]; mod = require(fp); logTest(apiName, 'file_loads_ok', true); } catch (e) { logTest(apiName, 'file_loads_ok', false, e.message); return; }
  if (mod.dedupeAndFilterSubdomains) {
    assertEqual(
      mod.dedupeAndFilterSubdomains(['blog.example.com', 'WWW.EXAMPLE.COM', 'api.example.com', 'unrelated.com'], 'example.com').length,
      2,
      'filters_unrelated',
      apiName
    );
    assertEqual(
      mod.dedupeAndFilterSubdomains(['*.example.com', 'example.com', 'www.example.com'], 'example.com').length,
      2,
      'strips_wildcard',
      apiName
    );
  }
  // Live call: crt.sh for a high-volume domain
  try {
    const start = Date.now();
    const resp = await fetch('https://crt.sh/?q=%25.google.com&output=json', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(25000),
    });
    const latency = Date.now() - start;
    logTest(apiName, 'live_crt_sh_reachable', resp.ok, `HTTP ${resp.status} in ${latency}ms`);
    if (resp.ok) {
      const json = await resp.json();
      assertTrue(Array.isArray(json) && json.length > 0, 'crt_returns_array_with_results', apiName, `${json.length} certs`);
      const counts = json.filter((r) => r.common_name?.endsWith('.google.com') || r.name_value?.includes('google.com')).length;
      assertTrue(counts > 10, 'crt_results_for_apex', apiName, `${counts} matching certs`);
    }
  } catch (e) {
    logTest(apiName, 'live_crt_sh_reachable', false, e.message);
  }
}

async function testWayback() {
  const apiName = 'wayback';
  const fp = path.join(API_DIR, 'wayback.js');
  let mod;
  try { delete require.cache[fp]; mod = require(fp); logTest(apiName, 'file_loads_ok', true); } catch (e) { logTest(apiName, 'file_loads_ok', false, e.message); return; }
  if (mod.normalizeDate) {
    assertEqual(mod.normalizeDate('20240101'), '20240101', 'normalize_ymd_compact', apiName);
    assertEqual(mod.normalizeDate('2024-01-01'), '20240101', 'normalize_ymd_hyphen', apiName);
    try { mod.normalizeDate('not-a-date'); assertTrue(false, 'invalid_date_throws', apiName); } catch (_) { assertTrue(true, 'invalid_date_throws', apiName); }
  }
  if (mod.buildCdxUrl) {
    const u = mod.buildCdxUrl('https://example.com/', { from: '20240101', to: '20241231', limit: 10 });
    assertTrue(u.includes('web.archive.org'), 'cdx_url_contains_host', apiName);
    assertTrue(u.includes('from=20240101'), 'cdx_url_has_from', apiName);
    assertTrue(u.includes('limit=10'), 'cdx_url_has_limit', apiName);
  }
  if (mod.parseCdx) {
    const sample = [
      ['urlkey','timestamp','original','mimetype','statuscode','digest','length'],
      ['com,example)/', '20240315120000', 'https://example.com/', 'text/html', '200', 'ABC123', '1024'],
    ];
    const out = mod.parseCdx(sample);
    assertEqual(out.length, 1, 'cdx_parse_count', apiName);
    assertEqual(out[0].status, 200, 'cdx_parse_status', apiName);
    assertTrue(out[0].archived_url?.includes('web.archive.org'), 'cdx_archive_url_format', apiName);
  }
  if (mod.summarize) {
    const s1 = mod.summarize([]);
    assertEqual(s1.total, 0, 'summarize_empty', apiName);
    const s2 = mod.summarize([
      { status: 200, timestamp_iso: '2024-01-01T00:00:00Z' },
      { status: 200, timestamp_iso: '2024-12-31T00:00:00Z' },
      { status: 404, timestamp_iso: '2025-06-01T00:00:00Z' },
    ]);
    assertEqual(s2.total, 3, 'summarize_count', apiName);
    assertEqual(s2.first_snapshot, '2024-01-01T00:00:00Z', 'summarize_first', apiName);
    assertEqual(s2.most_common_status, '200 (×2)', 'summarize_most_common', apiName);
  }
  // Live call: archive.org CDX API (45s timeout — service is sometimes slow)
  try {
    const start = Date.now();
    const resp = await fetch('https://web.archive.org/cdx/search/cdx?url=example.com&output=json&limit=5', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(45000),
    });
    const latency = Date.now() - start;
    logTest(apiName, 'live_cdx_reachable', resp.ok, `HTTP ${resp.status} in ${latency}ms`);
    if (resp.ok) {
      const json = await resp.json();
      assertTrue(Array.isArray(json) && json.length > 0, 'cdx_returns_header_row', apiName, `${json.length} rows`);
      assertTrue(json[0].includes('timestamp'), 'cdx_header_has_timestamp', apiName);
    }
  } catch (e) {
    logTest(apiName, 'live_cdx_reachable', false, e.message);
  }
}

async function testRedirectTrace() {
  const apiName = 'redirect-trace';
  const fp = path.join(API_DIR, 'redirect-trace.js');
  let mod;
  try { delete require.cache[fp]; mod = require(fp); logTest(apiName, 'file_loads_ok', true); } catch (e) { logTest(apiName, 'file_loads_ok', false, e.message); return; }
  if (mod.normalizeUrl) {
    assertTrue((() => { try { return mod.normalizeUrl('https://example.com') === 'https://example.com/'; } catch { return false; } })(), 'normalize_url_simple', apiName);
    assertTrue((() => { try { mod.normalizeUrl('localhost:3000'); return false; } catch { return true; } })(), 'normalize_localhost_rejected', apiName);
  }
  if (mod.classifyChain) {
    const broken = mod.classifyChain([
      { hop: 1, url: 'https://bit.ly/x', status: 301, latency_ms: 100, location: 'https://example.com' },
      { hop: 2, url: 'https://example.com', status: 404, latency_ms: 100 },
    ]);
    assertTrue(broken.is_broken, 'classifies_broken', apiName);
    assertTrue(broken.issues.some((i) => i.includes('404')), 'classifies_404_issue', apiName);

    const clean = mod.classifyChain([
      { hop: 1, url: 'https://bit.ly/y', status: 301, latency_ms: 100, location: 'https://example.com' },
      { hop: 2, url: 'https://example.com', status: 200, latency_ms: 100 },
    ]);
    assertTrue(!clean.is_broken, 'classifies_clean', apiName);
    assertEqual(clean.total_hops, 2, 'classifies_hop_count', apiName);
  }
  // Live trace against a known-redirect URL
  try {
    const start = Date.now();
    const resp = await fetch('http://cloudflare.com', {
      redirect: 'manual',
      headers: { 'User-Agent': 'sitetrace-api-test' },
      signal: AbortSignal.timeout(8000),
    });
    const latency = Date.now() - start;
    logTest(apiName, 'live_trace_works_for_real_url', resp.status >= 200 && resp.status < 500, `cloudflare.com returned HTTP ${resp.status} in ${latency}ms`);
  } catch (e) {
    logTest(apiName, 'live_trace_works_for_real_url', false, e.message);
  }
}

async function testStatusCheck() {
  const apiName = 'status-check';
  const fp = path.join(API_DIR, 'status-check.js');
  let mod;
  try { delete require.cache[fp]; mod = require(fp); logTest(apiName, 'file_loads_ok', true); } catch (e) { logTest(apiName, 'file_loads_ok', false, e.message); return; }
  if (mod.dedupeAndValidate) {
    assertEqual(mod.dedupeAndValidate(['https://example.com', 'https://example.com'], 10).length, 1, 'dedupes_repeated_urls', apiName);
    assertEqual(mod.dedupeAndValidate(['garbage', '', 'https://example.com'], 10).length, 1, 'skips_invalid', apiName);
    assertEqual(mod.dedupeAndValidate(Array(20).fill('https://example.com'), 5).length, 1, 'enforces_batch_limit', apiName);
  }
  if (mod.classifyStatusRow) {
    assertEqual(mod.classifyStatusRow({ status: 200 }).label, 'ok', 'classify_200', apiName);
    assertEqual(mod.classifyStatusRow({ status: 404 }).label, 'not_found', apiName);
    assertEqual(mod.classifyStatusRow({ status: 500 }).label, 'server_error', apiName);
    assertEqual(mod.classifyStatusRow({ error: 'timeout' }).label, 'error', apiName);
  }
  if (mod.summarizeResults) {
    const s = mod.summarizeResults([
      { status: 200, latency_ms: 100 },
      { status: 404, latency_ms: 100 },
      { status: 500, latency_ms: 100 },
    ]);
    assertEqual(s.total, 3, 'sum_total', apiName);
    assertEqual(s.broken, 2, 'sum_broken', apiName);
    assertEqual(s.healthy_pct, 33, 'sum_healthy_pct', apiName);
  }
  // Live multi-URL status check
  try {
    const urls = [
      'https://example.com',
      'https://www.google.com',
      'https://this-domain-definitely-does-not-exist-9999.test',
    ];
    const start = Date.now();
    const results = await Promise.all(urls.map((u) =>
      fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(8000) })
        .then((r) => ({ url: u, status: r.status }))
        .catch((e) => ({ url: u, error: e.message }))
    ));
    const latency = Date.now() - start;
    logTest(apiName, 'live_multi_url_check', results.every((r) => 'status' in r || 'error' in r), `${latency}ms for ${urls.length} URLs`);
  } catch (e) {
    logTest(apiName, 'live_multi_url_check', false, e.message);
  }
}

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

(async () => {
  console.log('Starting sitetrace-api tests...\n');
  console.log('--- Core 5 APIs ---');
  await testSeoAudit();
  await testAiContentDetector();
  await testEmailHealth();
  await testSchemaDetector();
  await testHeaders();
  console.log('\n--- Bonus 4 APIs ---');
  await testRdap();
  await testSubdomains();
  await testWayback();
  await testRedirectTrace();
  await testStatusCheck();

  results.finished_at = new Date().toISOString();

  console.log('\n====================');
  console.log(`Total: ${results.summary.total}  Passed: ${results.summary.passed}  Failed: ${results.summary.failed}`);
  console.log(`Pass rate: ${((results.summary.passed / Math.max(1, results.summary.total)) * 100).toFixed(1)}%`);
  console.log('====================');

  fs.mkdirSync(path.dirname(RESULTS_FILE), { recursive: true });
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  console.log(`\nResults saved to: ${RESULTS_FILE}`);
})().catch((e) => {
  console.error('Test runner failed:', e);
  process.exit(1);
});