// =====================================================================
// scripts/test-paddle-webhook.mjs
//
// End-to-end smoke test for the Paddle webhook handler. Runs from your
// dev machine, no Paddle UI needed:
//
//   1. POST /api/signup with a fresh test email → creates a free-tier
//      user in D1 (idempotent — returns the same key if email exists).
//   2. Builds a subscription.created event for that user's email with
//      the Hobby product ID.
//   3. HMAC-SHA256 signs the body using PADDLE_WEBHOOK_SECRET and POSTs
//      to https://api.sitetrace.it.com/api/paddle-webhook.
//   4. Logs the response. A 200 with `received: true` means the handler
//      accepted the event; check the D1 row to confirm plan flipped to
//      `hobby` + daily_quota = 1000.
//
// Usage:
//   node scripts/test-paddle-webhook.mjs            # Hobby upgrade
//   node scripts/test-paddle-webhook.mjs pro        # Pro upgrade
//   node scripts/test-paddle-webhook.mjs cancel     # cancellation
//   $env:TEST_EMAIL = "you@..."; node ...           # custom email
// =====================================================================

import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';

const API_BASE  = 'https://api.sitetrace.it.com';
const TEST_PRODUCT_HOBBY  = 'pro_01m3tc3y6p4sf9xn01zknr03jp';
const TEST_PRODUCT_PRO    = 'pro_01m3tchdmcwqdpkh6tkarwacar';
const TEST_PRODUCT_VOLUME = 'pro_01m3tcrgxj2wa0w489zmysbc6d';

// Read .env.local for PADDLE_WEBHOOK_SECRET
const envText = readFileSync('.env.local', 'utf8');
const secretMatch = envText.match(/^PADDLE_WEBHOOK_SECRET=(.+)$/m);
if (!secretMatch) {
  console.error('❌ PADDLE_WEBHOOK_SECRET not found in .env.local');
  process.exit(1);
}
const WEBHOOK_SECRET = secretMatch[1].trim();

const mode = process.argv[2] || 'hobby';
const TEST_EMAIL = process.env.TEST_EMAIL || `paddle-test+${Date.now()}@sitetrace.it.com`;

const PRODUCT_FOR_MODE = {
  hobby:  TEST_PRODUCT_HOBBY,
  pro:    TEST_PRODUCT_PRO,
  volume: TEST_PRODUCT_VOLUME,
}[mode];

const IS_CANCEL = (mode === 'cancel');

if (!PRODUCT_FOR_MODE && !IS_CANCEL) {
  console.error('❌ Unknown mode. Use: hobby | pro | volume | cancel');
  process.exit(1);
}

console.log(`\n🧪 sitetrace-api Paddle webhook smoke test`);
console.log(`   mode:    ${mode}`);
console.log(`   email:   ${TEST_EMAIL}`);
console.log(`   product: ${IS_CANCEL ? '(cancel — preserves existing plan)' : PRODUCT_FOR_MODE}`);
console.log(`   secret:  ${WEBHOOK_SECRET.slice(0,12)}…\n`);

// ---------------------------------------------------------------------
// 1. Sign up the test user (creates a free-tier D1 row)
// ---------------------------------------------------------------------
console.log('1️⃣  Signing up test user…');
const signupRes = await fetch(`${API_BASE}/api/signup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: TEST_EMAIL }),
});
const signup = await signupRes.json();
if (!signup.ok) {
  console.error('   ❌ signup failed:', signup);
  process.exit(1);
}
console.log(`   ✅ user exists: plan=${signup.user.plan} status=${signup.user.status} quota=${signup.user.daily_quota}`);
console.log(`   api_key=${signup.user.api_key.slice(0,12)}…\n`);

// ---------------------------------------------------------------------
// 1b. If cancelling, first send a subscription.created so the user has
//     a paddle_customer_id in D1 (cancel handler looks up by that).
// ---------------------------------------------------------------------
let cancelCustomerId;
if (IS_CANCEL) {
  console.log('1️⃣b  Setting up paddle_customer_id via subscription.created…');
  cancelCustomerId = 'ctm_test_' + Math.random().toString(36).slice(2, 12);
  const setupPayload = {
    event_id: 'evt_setup_' + Math.random().toString(36).slice(2, 10),
    event_type: 'subscription.created',
    occurred_at: new Date().toISOString(),
    data: {
      id: 'sub_setup_' + Math.random().toString(36).slice(2, 10),
      status: 'active',
      customer_id: cancelCustomerId,
      customer: { email: TEST_EMAIL },
      current_billing_period: { ends_at: new Date(Date.now() + 30*24*60*60*1000).toISOString() },
      items: [{ price: { product_id: TEST_PRODUCT_HOBBY } }],
    },
  };
  const setupBody = JSON.stringify(setupPayload);
  const setupTs = Math.floor(Date.now() / 1000).toString();
  const setupH1 = createHmac('sha256', WEBHOOK_SECRET).update(`${setupTs}.${setupBody}`).digest('hex');
  const setupRes = await fetch(`${API_BASE}/api/paddle-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Paddle-Signature': `ts=${setupTs};h1=${setupH1}` },
    body: setupBody,
  });
  if (setupRes.status !== 200) {
    console.error('   ❌ setup failed:', setupRes.status, await setupRes.text());
    process.exit(1);
  }
  console.log('   ✅ user is now subscribed (hobby) with paddle_customer_id set\n');
}

// ---------------------------------------------------------------------
// 2. Build a Paddle webhook event payload
// ---------------------------------------------------------------------
const eventId   = 'evt_test_' + Math.random().toString(36).slice(2, 12);
const now       = new Date().toISOString();
const customerId = 'ctm_test_' + Math.random().toString(36).slice(2, 12);
const subscriptionId = 'sub_test_' + Math.random().toString(36).slice(2, 12);
const periodEnd = new Date(Date.now() + 30*24*60*60*1000).toISOString();

let eventType, payload;

if (IS_CANCEL) {
  eventType = 'subscription.canceled';
  payload = {
    event_id: eventId,
    event_type: eventType,
    occurred_at: now,
    data: {
      id: subscriptionId,
      status: 'canceled',
      customer_id: cancelCustomerId,
      customer: { email: TEST_EMAIL },
      current_billing_period: { ends_at: periodEnd },
      items: [{ price: { product_id: TEST_PRODUCT_HOBBY } }],
    },
  };
} else {
  eventType = 'subscription.created';
  payload = {
    event_id: eventId,
    event_type: eventType,
    occurred_at: now,
    data: {
      id: subscriptionId,
      status: 'active',
      customer_id: customerId,
      customer: { email: TEST_EMAIL },
      current_billing_period: { ends_at: periodEnd },
      items: [{ price: { product_id: PRODUCT_FOR_MODE } }],
    },
  };
}

const rawBody = JSON.stringify(payload);

// ---------------------------------------------------------------------
// 3. Sign with HMAC-SHA256 (Paddle-Signature header format)
// ---------------------------------------------------------------------
const ts = Math.floor(Date.now() / 1000).toString();
const signedPayload = `${ts}.${rawBody}`;
const h1 = createHmac('sha256', WEBHOOK_SECRET).update(signedPayload).digest('hex');
const sigHeader = `ts=${ts};h1=${h1}`;

console.log(`2️⃣  Sending signed ${eventType} → ${API_BASE}/api/paddle-webhook`);
console.log(`   signature: ts=${ts};h1=${h1.slice(0,16)}…\n`);

// ---------------------------------------------------------------------
// 4. POST to webhook
// ---------------------------------------------------------------------
const res = await fetch(`${API_BASE}/api/paddle-webhook`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Paddle-Signature': sigHeader,
  },
  body: rawBody,
});

const body = await res.text();
let parsed;
try { parsed = JSON.parse(body); } catch (_) { parsed = body; }

console.log(`3️⃣  Response: ${res.status} ${res.statusText}`);
console.log('   body:', JSON.stringify(parsed, null, 2));

if (res.status === 200 && parsed.received) {
  console.log(`\n✅ Webhook accepted.`);
  console.log(`   Verify plan flip: curl "${API_BASE}/api/account?key=${signup.user.api_key}"`);
  console.log(`   or open: https://api.sitetrace.it.com/dashboard?key=${signup.user.api_key}`);
  process.exit(0);
}
if (res.status === 503) {
  console.log(`\n❌ Not configured — secret not yet wired in CF Pages dashboard.`);
  console.log(`   Did the 2 secrets deploy? Check Deployments tab + wait 30s.`);
}
if (res.status === 401) {
  console.log(`\n❌ Signature failed.`);
  console.log(`   WEBHOOK_SECRET in CF Pages ≠ the one Paddle showed after events save.`);
  console.log(`   Compare: ntfset_01m3terg5n1zzjgsk01q23xe83`);
}
process.exit(1);
