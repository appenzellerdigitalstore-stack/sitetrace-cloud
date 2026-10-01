// =====================================================================
// scripts/resync-paddle-subscription.mjs
//
// One-off helper: re-sends a signed webhook event for a known Paddle
// subscription/customer pair. Useful when a webhook delivery happened
// before the user existed in D1 (pre-signup bug) or the D1 row got
// stuck in a stale state.
//
// Usage:
//   node scripts/resync-paddle-subscription.mjs <email> <plan>
//   plan in {hobby, pro, volume}
//
// Reads PADDLE_WEBHOOK_SECRET and PADDLE_PRODUCT_* from .env.local.
// Fetches the active subscription + customer for <email>, signs a
// subscription.updated event with status='active', and POSTs to
// /api/paddle-webhook.
// =====================================================================

import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';

const API_BASE = 'https://api.sitetrace.it.com';
const SANDBOX  = 'https://sandbox-api.paddle.com';

const envText = readFileSync('.env.local', 'utf8');
const env = Object.fromEntries(
  envText.split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('='))
    .map(l => l.split('=', 2))
);

const email = (process.argv[2] || '').trim().toLowerCase();
const plan  = (process.argv[3] || 'hobby').trim().toLowerCase();

const PRODUCT_ID = {
  hobby:  env.PADDLE_PRODUCT_HOBBY_SANDBOX,
  pro:    env.PADDLE_PRODUCT_PRO_SANDBOX,
  volume: env.PADDLE_PRODUCT_VOLUME_SANDBOX,
}[plan];

if (!email || !PRODUCT_ID) {
  console.error('Usage: node scripts/resync-paddle-subscription.mjs <email> <plan>');
  process.exit(1);
}

console.log(`\nResync helper`);
console.log(`  email: ${email}`);
console.log(`  plan:  ${plan}`);
console.log(`  product: ${PRODUCT_ID}\n`);

const PADDLE_KEY = env.PADDLE_API_KEY;
const SEC = env.PADDLE_WEBHOOK_SECRET;

// 1. Find the active subscription for this email in Paddle sandbox.
const custRes = await fetch(`${SANDBOX}/customers?email=${encodeURIComponent(email)}`, {
  headers: { Authorization: `Bearer ${PADDLE_KEY}` },
});
const custJson = await custRes.json();
const customer = (custJson.data || []).find(c => c.email && c.email.toLowerCase() === email);
if (!customer) {
  console.error(`❌ No Paddle customer found for ${email}`);
  process.exit(1);
}
console.log(`  customer: ${customer.id}`);

const subRes = await fetch(`${SANDBOX}/subscriptions?customer_id=${customer.id}&status=active`, {
  headers: { Authorization: `Bearer ${PADDLE_KEY}` },
});
const subJson = await subRes.json();
const sub = (subJson.data || [])[0];
if (!sub) {
  console.error(`❌ No active subscription for ${customer.id}`);
  process.exit(1);
}
console.log(`  subscription: ${sub.id} (status=${sub.status})`);

// 2. Build a subscription.updated event payload that matches the handler.
const eventId = 'evt_resync_' + Math.random().toString(36).slice(2, 12);
const periodEnd = sub.current_billing_period?.ends_at || new Date(Date.now() + 30*86400000).toISOString();

const payload = {
  event_id: eventId,
  event_type: 'subscription.updated',
  occurred_at: new Date().toISOString(),
  data: {
    id: sub.id,
    status: sub.status,
    customer_id: customer.id,
    customer: { email },
    current_billing_period: { ends_at: periodEnd },
    items: [{ price: { product_id: PRODUCT_ID } }],
  },
};

const rawBody = JSON.stringify(payload);
const ts = Math.floor(Date.now() / 1000).toString();
const h1 = createHmac('sha256', SEC).update(`${ts}.${rawBody}`).digest('hex');

// 3. POST to webhook.
const res = await fetch(`${API_BASE}/api/paddle-webhook`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Paddle-Signature': `ts=${ts};h1=${h1}`,
  },
  body: rawBody,
});

const body = await res.json();
console.log(`\nWebhook response: ${res.status}`);
console.log(JSON.stringify(body, null, 2));

if (res.status !== 200) {
  console.error('❌ Webhook failed');
  process.exit(1);
}
console.log(`\n✅ Done. Verify with:`);
console.log(`  curl "${API_BASE}/api/account?key=$YOUR_KEY"`);
