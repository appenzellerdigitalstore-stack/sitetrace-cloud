// Quick retry of the 2 failed tests
const tests = [];

async function runTest(name, fn) {
  try {
    const result = await fn();
    const passed = result.ok;
    console.log((passed ? '✓' : '✗') + ' ' + name + ' ' + (result.note || ''));
    tests.push({ name, passed, note: result.note || '' });
  } catch (e) {
    console.log('✗ ' + name + ' ERROR ' + e.message);
    tests.push({ name, passed: false, note: e.message });
  }
}

(async () => {
  // 1. RDAP — try with browser UA
  await runTest('rdap_browser_ua', async () => {
    const start = Date.now();
    const r = await fetch('https://rdap.org/domain/google.com', {
      headers: {
        Accept: 'application/rdap+json, application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(12000),
    });
    const latency = Date.now() - start;
    const txt = await r.text();
    return {
      ok: r.ok,
      note: `HTTP ${r.status} in ${latency}ms, body_first_100=${txt.slice(0, 100).replace(/\n/g, ' ')}`,
    };
  });

  // 2. RDAP via different endpoint (IANA bootstrap)
  await runTest('rdap_iana_bootstrap', async () => {
    const r = await fetch('https://data.iana.org/rdap/asn/15169.json', {
      signal: AbortSignal.timeout(10000),
    });
    return { ok: r.ok, note: `HTTP ${r.status}` };
  });

  // 3. Wayback — retry with longer timeout
  await runTest('wayback_cdx_longer_timeout', async () => {
    const start = Date.now();
    const r = await fetch('https://web.archive.org/cdx/search/cdx?url=example.com&output=json&limit=5', {
      signal: AbortSignal.timeout(45000),
    });
    const latency = Date.now() - start;
    if (r.ok) {
      const j = await r.json();
      return { ok: true, note: `HTTP ${r.status} in ${latency}ms, ${j.length} rows` };
    }
    return { ok: r.ok, note: `HTTP ${r.status} in ${latency}ms` };
  });

  // 4. Wayback via web.archive.org directly (availability endpoint)
  await runTest('wayback_availability_endpoint', async () => {
    const start = Date.now();
    const r = await fetch('https://archive.org/wayback/available?url=example.com', {
      signal: AbortSignal.timeout(15000),
    });
    const latency = Date.now() - start;
    return { ok: r.ok, note: `HTTP ${r.status} in ${latency}ms` };
  });

  // Summary
  console.log('\n--- Retry Summary ---');
  const passed = tests.filter((t) => t.passed).length;
  console.log(`${passed}/${tests.length} passed on retry`);
  console.log(JSON.stringify(tests, null, 2));
})();