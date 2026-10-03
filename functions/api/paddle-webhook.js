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
  if (!email) return null;
  // Case-insensitive — Paddle customer email may differ in casing from the
  // email the user typed into /api/signup (which we already lowercase in
  // /api/signup, but be defensive here too).
  const norm = email.trim().toLowerCase();
  return await db.prepare(
    'SELECT id, email, api_key, plan, status, paddle_customer_id FROM users WHERE LOWER(email) = ? LIMIT 1'
  ).bind(norm).first();
}

async function findUserByPaddleCustomer(db, paddleCustomerId) {
  return await db.prepare(
    'SELECT id, email, api_key, plan, status, paddle_customer_id FROM users WHERE paddle_customer_id = ? LIMIT 1'
  ).bind(paddleCustomerId).first();
}

// Try paddle_customer_id first (specific). Fall back to email — a freshly
// signup'd user has paddle_customer_id = NULL until the first webhook
// updates it, so onSubscriptionUpdated MUST be able to find them by email,
// otherwise the very first subscription.updated event is a silent no-op
// and the D1 row never gets upgraded.
//
// Side-effect: if found via email, we patch in paddle_customer_id + sub id
// right now via applyPlanChange so future events find them by id.
async function findUserForEvent(db, event) {
  const customerId = event?.data?.customer_id;
  if (customerId) {
    const byCust = await findUserByPaddleCustomer(db, customerId);
    if (byCust) return byCust;
  }
  const email = event?.data?.customer?.email;
  if (email) {
    const byEmail = await findUserByEmail(db, email);
    if (byEmail) return byEmail;
  }
  return null;
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
  const user = await findUserForEvent(db, event);
  if (!user) {
    console.error('paddle-webhook: subscription.created: no matching user', {
      email: event.data?.customer?.email,
      customer_id: event.data?.customer_id,
    });
    return;
  }
  const items = event.data?.items || [];
  const productId = items[0]?.price?.product_id || items[0]?.product_id || null;
  const plan = planFromProductId(env, productId);
  if (!plan) {
    console.error('paddle-webhook: subscription.created: unknown product_id', productId);
    return;
  }
  // active subscription; not yet canceled
  await applyPlanChange(db, user, event, plan, 'active', null);
}

async function onSubscriptionUpdated(db, env, event) {
  const user = await findUserForEvent(db, event);
  if (!user) {
    console.error('paddle-webhook: subscription.updated: no matching user', {
      email: event.data?.customer?.email,
      customer_id: event.data?.customer_id,
    });
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
  const user = await findUserForEvent(db, event);
  if (!user) {
    console.error('paddle-webhook: subscription.canceled: no matching user', {
      email: event.data?.customer?.email,
      customer_id: event.data?.customer_id,
    });
    return;
  }
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
    return withStats(env, jsonResponse({
      error: 'not_configured',
      message: 'PADDLE_WEBHOOK_SECRET env var not set. See wrangler.toml / CF dashboard.',
    }, 503));
  }

  if (!env.DB) {
    return withStats(env, jsonResponse({
      error: 'not_configured',
      message: 'D1 binding missing — re-check wrangler.toml [[d1_databases]] block',
    }, 503));
  }

  // Paddle posts JSON. Read raw body once — needed for both signature
  // verification (must use the exact bytes Paddle signed) and JSON parse.
  const rawBody = await request.text();
  const sigHeader = request.headers.get('Paddle-Signature');

  const valid = await verifyPaddleSignature(rawBody, sigHeader, env.PADDLE_WEBHOOK_SECRET);
  if (!valid) {
    return withStats(env, jsonResponse({
      error: 'invalid_signature',
      message: 'HMAC verification failed — check PADDLE_WEBHOOK_SECRET matches Paddle dashboard',
    }, 401));
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (_) {
    return withStats(env, jsonResponse({ error: 'invalid_json' }, 400));
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
    return withStats(env, jsonResponse({
      error: 'handler_failed',
      event_type: eventType,
      message: e?.message || String(e),
    }, 500));
  }

  // Paddle expects 2xx quickly; ack with the event_id so the dashboard
  // shows "delivered" status
  return withStats(env, jsonResponse({
    received: true,
    event_id: event.event_id,
    event_type: eventType,
    processed_at: new Date().toISOString(),
  }, 200));
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

// ---------------------------------------------------------------------------
// Webhook observability — KV-backed counter per (day, status) so the
// dashboard can surface "we got N 401s in the last 24h" without grepping
// logs. Uses the same RATELIMIT KV namespace as the IP rate-limit (cheap
// increments, no cost concerns; namespaces are just buckets).
//
// Failure mode: if KV is unavailable, we still return the response —
// monitoring must never break the request path.
// ---------------------------------------------------------------------------
async function recordWebhookStat(env, status) {
  try {
    const day = new Date().toISOString().slice(0, 10); // UTC date
    // Two buckets: total + per-status. Total lets the dashboard show
    // "N deliveries today"; per-status lets it show the breakdown and
    // alert on any 401/5xx.
    const totalKey = `wh:${day}:total`;
    const statusKey = `wh:${day}:${status}`;
    // KV doesn't have a native INCR, so we read-modify-write. Concurrent
    // webhook deliveries from Paddle are extremely rare so this is fine;
    // if we ever see race issues, switch to a Workers Analytics Engine
    // dataset (also free, but more setup).
    const [t, s] = await Promise.all([
      env.RATELIMIT.get(totalKey),
      env.RATELIMIT.get(statusKey),
    ]);
    const newTotal = (parseInt(t || '0', 10) || 0) + 1;
    const newStatus = (parseInt(s || '0', 10) || 0) + 1;
    await Promise.all([
      env.RATELIMIT.put(totalKey, String(newTotal), { expirationTtl: 60 * 60 * 24 * 30 }),
      env.RATELIMIT.put(statusKey, String(newStatus), { expirationTtl: 60 * 60 * 24 * 30 }),
    ]);
  } catch (e) {
    console.error('paddle-webhook: recordWebhookStat failed', e?.message || e);
  }
}

// Wrap a Response and increment the per-status counter. Use like:
//   return withStats(env, jsonResponse({...}, 401));
//
// Note: we await the counter (KV write is ~5ms) rather than fire-and-forget,
// because we don't have context.waitUntil exposed here without restructuring.
// At CF scale this is fine — webhooks are <1000/day even at $3k MRR.
async function withStats(env, response) {
  await recordWebhookStat(env, response.status);
  return response;
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
