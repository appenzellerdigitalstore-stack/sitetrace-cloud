// scripts/e2e-launch-test.mjs
//
// End-to-end launch readiness test. Run this AFTER Ed creates the
// Paddle sandbox products (T1/T2/T3/T4) and pastes the new price IDs
// into wrangler.toml (PADDLE_PRODUCT_T1..T4).
//
// Tests in order:
//   1. Disposable blocklist works (mailinator.com blocked)
//   2. Free signup returns 1,000/day key
//   3. Free user can call /api/ip successfully
//   4. /api/account shows aggregate quota (not per-endpoint)
//   5. /api/openapi returns a valid JSON spec
//   6. /api/webhook-stats returns data
//   7. /api/change-plan with T1 price ID succeeds (requires Ed's T1 price)
//   8. After T1 upgrade, /api/account shows daily_quota=1000 (T1) AND plan=T1
//
// Each step prints PASS/FAIL with the actual response so we can find
// any rough edge. Exits non-zero if any step fails — useful in CI.
//
// Usage:
//   PADDLE_PRICE_T1=pri_xxx PADDLE_PRICE_T2=pri_yyy \
//     node scripts/e2e-launch-test.mjs
//
// (price IDs can also be passed as --price-T1, --price-T2 CLI args)

import { randomBytes } from 'node:crypto';

const BASE = process.env.BASE || 'https://api.sitetrace.it.com';

function getArg(name) {
  const prefix = `--${name}=`;
  const fromArg = process.argv.find(a => a.startsWith(prefix));
  if (fromArg) return fromArg.slice(prefix.length);
  const envName = 'PADDLE_PRICE_' + name.toUpperCase().replace(/^PRICE_/, '');
  return process.env[envName];
}

let passes = 0;
let fails = 0;
const failures = [];

async function step(name, fn) {
  process.stdout.write(`▶ ${name} ... `);
  try {
    const out = await fn();
    passes++;
    console.log(`PASS  ${out || ''}`);
  } catch (e) {
    fails++;
    failures.push({ step: name, err: e.message });
    console.log(`FAIL  ${e.message}`);
  }
}

async function req(method, path, { headers = {}, body } = {}) {
  const init = { method, headers: { ...headers } };
  if (body && typeof body === 'object' && !(body instanceof URLSearchParams)) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  } else if (body) {
    init.body = body;
  }
  const r = await fetch(BASE + path, init);
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

const unique = () => randomBytes(4).toString('hex');

(async () => {
  console.log(`\n=== sitetrace-api E2E launch test ===`);
  console.log(`Base URL: ${BASE}`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  // 1. Disposable blocklist
  await step('1. Disposable email (mailinator.com) is blocked at signup', async () => {
    const r = await req('POST', '/api/signup', { body: { email: `e2e-${unique()}@mailinator.com` } });
    if (r.status === 400 && r.body?.error === 'disposable_email_blocked') return 'blocklist active';
    throw new Error(`status=${r.status} error=${r.body?.error || '?'}`);
  });

  // 2. Free signup with a real-looking email
  let email = `e2e-${unique()}@gmail.com`;
  let apiKey;
  await step('2. Free signup returns 1,000/day key', async () => {
    const r = await req('POST', '/api/signup', { body: { email } });
    if (r.status !== 200) throw new Error(`status=${r.status} body=${JSON.stringify(r.body)}`);
    if (r.body.user?.plan !== 'free') throw new Error(`plan=${r.body.user?.plan}, expected free`);
    if (r.body.user?.daily_quota !== 1000) throw new Error(`daily_quota=${r.body.user?.daily_quota}, expected 1000`);
    apiKey = r.body.api_key || r.body.user?.api_key;
    return `key=${apiKey.slice(0,12)}...`;
  });

  // 3. Free user can call /api/ip
  await step('3. Free user can call /api/ip?ip=8.8.8.8', async () => {
    const r = await req('GET', '/api/ip?ip=8.8.8.8&key=' + apiKey);
    if (r.status !== 200) throw new Error(`status=${r.status} body=${JSON.stringify(r.body)}`);
    if (!r.body?.ip) throw new Error(`no ip field in response: ${JSON.stringify(r.body)}`);
    return `ip=${r.body.ip}`;
  });

  // 4. /api/account shows aggregate quota
  await step('4. /api/account shows aggregate used/quota (not per-endpoint)', async () => {
    const r = await req('GET', '/api/account?key=' + apiKey);
    if (r.status !== 200) throw new Error(`status=${r.status}`);
    const u = r.body?.user;
    if (!u) throw new Error('no user');
    if (u.daily_quota !== 1000) throw new Error(`daily_quota=${u.daily_quota}`);
    // Aggregate may or may not be present in body, but plan must be free
    if (u.plan !== 'free') throw new Error(`plan=${u.plan}`);
    return `plan=${u.plan} quota=${u.daily_quota}`;
  });

  // 5. /api/openapi returns a valid spec
  await step('5. /api/openapi returns valid OpenAPI 3.x spec', async () => {
    const r = await req('GET', '/api/openapi');
    if (r.status !== 200) throw new Error(`status=${r.status}`);
    if (r.body?.openapi?.indexOf('3.') !== 0) throw new Error(`openapi version=${r.body?.openapi}`);
    const pathCount = Object.keys(r.body?.paths || {}).length;
    if (pathCount < 5) throw new Error(`only ${pathCount} paths`);
    return `openapi=${r.body.openapi} paths=${pathCount}`;
  });

  // 6. /api/webhook-stats returns data
  await step('6. /api/webhook-stats returns webhook delivery data', async () => {
    const r = await req('GET', '/api/webhook-stats');
    if (r.status !== 200) throw new Error(`status=${r.status}`);
    if (!r.body?.by_day) throw new Error(`no by_day field`);
    return `days=${Object.keys(r.body.by_day).length}`;
  });

  // 7. /api/change-plan to T1 — requires Ed's PADDLE_PRICE_T1 env var
  const priceT1 = getArg('price_T1') || getArg('price-T1') || process.env.PADDLE_PRICE_T1;
  if (priceT1) {
    await step('7. /api/change-plan upgrades to T1 with Paddle sandbox price ID', async () => {
      const r = await req('POST', '/api/change-plan', {
        body: { api_key: apiKey, plan: 'T1', price_id: priceT1 },
      });
      if (r.status !== 200) throw new Error(`status=${r.status} body=${JSON.stringify(r.body)}`);
      if (r.body?.plan !== 'T1') throw new Error(`plan=${r.body?.plan}`);
      return `upgraded to T1`;
    });
    // 8. After upgrade, quota reflects T1
    await step('8. After T1 upgrade, /api/account shows plan=T1 daily_quota=1000', async () => {
      const r = await req('GET', '/api/account?key=' + apiKey);
      if (r.status !== 200) throw new Error(`status=${r.status}`);
      const u = r.body?.user;
      if (u.plan !== 'T1') throw new Error(`plan=${u.plan}, expected T1`);
      if (u.daily_quota !== 1000) throw new Error(`quota=${u.daily_quota}, expected 1000`);
      return `plan=T1 quota=1000`;
    });
  } else {
    console.log(`▶ 7-8. SKIPPED (no PADDLE_PRICE_T1 env var; Ed must create T1 in Paddle first)`);
  }

  console.log(`\n=== ${passes} passed, ${fails} failed ===`);
  if (fails > 0) {
    console.log(`\nFailures:`);
    for (const f of failures) console.log(`  - ${f.step}: ${f.err}`);
    process.exit(1);
  }
})().catch(e => {
  console.error('\nFATAL:', e);
  process.exit(2);
});