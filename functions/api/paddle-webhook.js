// =====================================================================
// sitetrace-api — Paddle Billing webhook (Cloudflare Workers)
//
// Receives subscription lifecycle events from Paddle, verifies the
// HMAC-SHA256 signature, and updates the corresponding user in D1.
//
// Events handled:
//   - subscription.created    → user upgrades to plan
//   - subscription.updated    → plan changes / status changes
//   - subscription.canceled   → schedule downgrade at period end
//
// Endpoint: POST /api/paddle-webhook
// Auth: none (public; signature verification instead)
// Middleware: functions/_middleware.js marks /api/paddle-webhook as public.
//
// SETUP (do once after Paddle account is created):
//   1. Paddle dashboard → Developer tools → API keys → + New API key
//      name: sitetrace-api   → copy key (shown once)
//   2. Paddle dashboard → Catalog → Products → + New product ×3
//      Hobby $9.99 / Pro $30 / Volume $499 — copy each product_id
//   3. Paddle dashboard → Developer tools → Notifications
//      → + New endpoint:
//         URL:           https://api.sitetrace.it.com/api/paddle-webhook
//         Events:        subscription.created
//                        subscription.updated
//                        subscription.canceled
//         Description:   sitetrace-api subscription sync
//      → copy the webhook secret (shown once)
//   4. CF Pages dashboard → Workers & Pages → sitetrace-api
//      → Settings → Variables and secrets → + Add
//        PADDLE_WEBHOOK_SECRET    [Secret]
//        PADDLE_API_KEY           [Secret, for future use]
//        PADDLE_PRODUCT_HOBBY     [Plain text, e.g. pro_01abc]
//        PADDLE_PRODUCT_PRO       [Plain text, e.g. pro_01def]
//        PADDLE_PRODUCT_VOLUME    [Plain text, e.g. pro_01ghi]
//   5. (Optional but recommended) send Paddle's "Test webhook" button
//      to verify the endpoint before going live.
// =====================================================================

// ---------------------------------------------------------------------
// Plan mapping + quotas
// ---------------------------------------------------------------------
// Product IDs are read from environment so sandbox and live can differ
// without code changes. PLANS maps the plan name to a daily call quota
// (mirrored in functions/_middleware.js — keep both in sync if you add
// a tier).
const PLANS = {
  free:   { daily: 100 },
  hobby:  { daily: 5000 },
  pro:    { daily: 30000 },
  volume: { daily: 200000 },
};

// Helper: derive the plan name from a Paddle product_id
function planFromProductId(env, productId) {
  if (!productId) return null;
  if (productId === env.PADDLE_PRODUCT_HOBBY)  return 'hobby';
  if (productId === env.PADDLE_PRODUCT_PRO)    return 'pro';
  if (productId === env.PADDLE_PRODUCT_VOLUME) return 'volume';
  return null;
}

// ---------------------------------------------------------------------
// Signature verification (Paddle Billing v2 webhook scheme)
//
// Header format: `Paddle-Signature: ts=1700000000;h1=abc123...`
// We sign `${ts}.${rawBody}` with HMAC-SHA256 using the webhook secret,
// then constant-time compare the hex digest against `h1`.
// Reference: https://developer.paddle.com/webhooks/signing
// ---------------------------------------------------------------------
async function verifyPaddleSignature(rawBody, headerValue, secret) {
  if (!headerValue || !secret) return false;

  const parts = {};
  for (const segment of headerValue.split(';')) {
    const eq = segment.indexOf('=');
    if (eq > 0) parts[segment.slice(0, eq).trim()] = segment.slice(eq + 1).trim();
  }
  const ts = parts.ts;
  const h1 = parts.h1;
  if (!ts || !h1) return false;

  const signed = `${ts}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuf = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(signed)
  );
  const expected = Array.from(new Uint8Array(sigBuf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time compare (avoids timing attacks on signature check)
  if (expected.length !== h1.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ h1.charCodeAt(i);
  }
  return mismatch === 0;
}

// ---------------------------------------------------------------------
// DB helpers — narrow, webhook-specific
// ---------------------------------------------------------------------
async function findUserByEmail(db, email) {
  return await db.prepare(
    'SELECT id, email, api_key, plan, status FROM users WHERE email = ? LIMIT 1'
  ).bind(email).first();
}

async function findUserByPaddleCustomer(db, paddleCustomerId) {
  return await db.prepare(
    'SELECT id, email, api_key, plan, status FROM users WHERE paddle_customer_id = ? LIMIT 1'
  ).bind(paddleCustomerId).first();
}

async function applyPlanChange(db, user, event, plan, status, cancelAt) {
  const now = Date.now();
  const customerId = event?.data?.customer_id || null;
  const subscriptionId = event?.data?.id || null;
  const quota = PLANS[plan]?.daily || PLANS.free.daily;

  // COALESCE keeps existing paddle_customer_id if this event has none
  // (defensive — Paddle events should always include it)
  await db.prepare(
    `UPDATE users
        SET plan = ?,
            status = ?,
            paddle_customer_id = COALESCE(?, paddle_customer_id),
            paddle_subscription_id = COALESCE(?, paddle_subscription_id),
            cancel_at = ?,
            daily_quota = ?,
            updated_at = ?
      WHERE id = ?`
  ).bind(
    plan,
    status,
    customerId,
    subscriptionId,
    cancelAt,
    quota,
    now,
    user.id
  ).run();
}

// ---------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------

// subscription.created — customer just paid. user MUST already exist
// (they hit /api/signup first, which created the D1 user row).
async function onSubscriptionCreated(db, env, event) {
  const customerEmail = event.data?.customer?.email;
  if (!customerEmail) {
    console.error('paddle-webhook: subscription.created missing customer.email');
    return;
  }
  const items = event.data?.items || [];
  const productId = items[0]?.price?.product_id || items[0]?.product_id || null;
  const plan = planFromProductId(env, productId);
  if (!plan) {
    console.error('paddle-webhook: subscription.created: unknown product_id', productId);
    return;
  }
  const user = await findUserByEmail(db, customerEmail);
  if (!user) {
    console.error('paddle-webhook: subscription.created: no user with email', customerEmail);
    return;
  }
  // active subscription; not yet canceled
  await applyPlanChange(db, user, event, plan, 'active', null);
}

async function onSubscriptionUpdated(db, env, event) {
  const customerId = event.data?.customer_id;
  if (!customerId) return;
  const user = await findUserByPaddleCustomer(db, customerId);
  if (!user) {
    console.error('paddle-webhook: subscription.updated: no user with paddle_customer_id', customerId);
    return;
  }
  const items = event.data?.items || [];
  const productId = items[0]?.price?.product_id || items[0]?.product_id || null;
  const plan = planFromProductId(env, productId) || user.plan;

  // Paddle statuses: active, past_due, paused, canceled, trialing
  const paddleStatus = event.data?.status;
  let status = user.status;
  if (paddleStatus === 'active' || paddleStatus === 'trialing') status = 'active';
  else if (paddleStatus === 'past_due') status = 'past_due';
  else if (paddleStatus === 'canceled') status = 'canceled';
  else if (paddleStatus === 'paused') status = 'expired';

  const periodEnd = event.data?.current_billing_period?.ends_at || null;
  const cancelAt = (status === 'canceled') ? periodEnd : null;

  await applyPlanChange(db, user, event, plan, status, cancelAt);
}

// subscription.canceled — keep the plan active until current period ends,
// then schedule the downgrade (the actual plan flip to 'free' happens
// when Paddle sends subscription.updated with status=canceled and the
// period end has passed, OR when the cancel_at < now check runs in the
// middleware before charging a call).
async function onSubscriptionCanceled(db, env, event) {
  const customerId = event.data?.customer_id;
  if (!customerId) return;
  const user = await findUserByPaddleCustomer(db, customerId);
  if (!user) return;
  const periodEnd = event.data?.current_billing_period?.ends_at || null;
  await applyPlanChange(db, user, event, user.plan, 'canceled', periodEnd);
}

// ---------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------
export async function onRequestPost(context) {
  const { request, env } = context;

  // Quick health response so Paddle's "test webhook" button doesn't
  // require all secrets configured
  if (!env.PADDLE_WEBHOOK_SECRET) {
    return jsonResponse({
      error: 'not_configured',
      message: 'PADDLE_WEBHOOK_SECRET env var not set. See wrangler.toml / CF dashboard.',
    }, 503);
  }

  if (!env.DB) {
    return jsonResponse({
      error: 'not_configured',
      message: 'D1 binding missing — re-check wrangler.toml [[d1_databases]] block',
    }, 503);
  }

  // Paddle posts JSON. Read raw body once — needed for both signature
  // verification (must use the exact bytes Paddle signed) and JSON parse.
  const rawBody = await request.text();
  const sigHeader = request.headers.get('Paddle-Signature');

  const valid = await verifyPaddleSignature(rawBody, sigHeader, env.PADDLE_WEBHOOK_SECRET);
  if (!valid) {
    return jsonResponse({
      error: 'invalid_signature',
      message: 'HMAC verification failed — check PADDLE_WEBHOOK_SECRET matches Paddle dashboard',
    }, 401);
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (_) {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }

  const eventType = event.event_type;
  try {
    switch (eventType) {
      case 'subscription.created':
        await onSubscriptionCreated(env.DB, env, event);
        break;
      case 'subscription.updated':
        await onSubscriptionUpdated(env.DB, env, event);
        break;
      case 'subscription.canceled':
        await onSubscriptionCanceled(env.DB, env, event);
        break;
      default:
        // Unhandled event types are fine — just log and ack 200
        console.log('paddle-webhook: ignoring event_type', eventType);
    }
  } catch (e) {
    console.error('paddle-webhook: handler failed for', eventType, e?.message || e);
    return jsonResponse({
      error: 'handler_failed',
      event_type: eventType,
      message: e?.message || String(e),
    }, 500);
  }

  // Paddle expects 2xx quickly; ack with the event_id so the dashboard
  // shows "delivered" status
  return jsonResponse({
    received: true,
    event_id: event.event_id,
    event_type: eventType,
    processed_at: new Date().toISOString(),
  }, 200);
}

// OPTIONS preflight — Paddle webhooks don't send OPTIONS, but include
// for completeness so CORS preflight from the dashboard doesn't fail
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Paddle-Signature',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Dual-export for Node test runner (matches the pattern in the other endpoints).
// The named exports let the Node test runner import individual helpers; the
// module.exports block covers CommonJS test runners.
export { verifyPaddleSignature, planFromProductId, PLANS };
if (typeof module !== 'undefined') {
  module.exports = {
    planFromProductId,
    verifyPaddleSignature,
    PLANS,
  };
}
