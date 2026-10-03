// =====================================================================
// sitetrace-api — Change subscription plan (Hobby <-> Pro)
//
// POST /api/change-plan   body: { key: "stk_...", plan: "pro" }
//
// Uses Paddle's REST API directly (not Paddle.js Checkout, which is for
// NEW subscriptions only). For an EXISTING subscriber, the correct path
// is PATCH /subscriptions/{id} with the new items + proration_billing_mode.
// This avoids the "Something went wrong" Paddle.js shows when you try to
// pass subscriptionId inside items[] (that's not a valid Paddle.js field).
//
// Proration: prorated_immediately — Paddle calculates the prorated
// difference for the remaining days in the current billing cycle and
// charges it immediately to the saved card. Hobby $9.99 -> Pro $30
// mid-cycle charges ~$20 (the difference for days remaining).
//
// Auth: api_key in body (not Bearer) so we don't have to teach the
// frontend a new header pattern; this endpoint is also added to
// PUBLIC_PATHS in _middleware.js so the quota counter doesn't tick.
// =====================================================================

const PLAN_TO_PRICE = {
  // T1-T4 sandbox price IDs. Ed to fill in once the products exist in
  // Paddle dashboard. Frontend pricing.html will mirror these. Until
  // then, requests to T1-T4 will return "pricing not configured".
  T1:     { price_id: '', plan: 'T1' },   // TODO: Ed — paste from Paddle
  T2:     { price_id: '', plan: 'T2' },   // TODO: Ed
  T3:     { price_id: '', plan: 'T3' },   // TODO: Ed
  T4:     { price_id: '', plan: 'T4' },   // TODO: Ed
  // Legacy: sandbox price IDs (Hobby $9.99, Pro $30). Kept so existing
  // sandbox customers can still change plan during testing.
  hobby:  { price_id: 'pri_01m3tceygyeetg9smeapr06ae1', plan: 'hobby' },
  pro:    { price_id: 'pri_01m3tcq9wmrbpn6ps3wdvkd5rc', plan: 'pro'   },
  // volume: archived — no price; if requested, error.
};

const PLAN_QUOTAS = {
  free:   100,
  T1:     1000,
  T2:     2000,
  T3:     3000,
  T4:     5000,
  // Legacy
  hobby:  5000,
  pro:    30000,
  volume: 200000,
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}

async function paddlePatchSubscription(env, subscriptionId, body) {
  const base = env.PADDLE_ENVIRONMENT === 'production'
    ? 'https://api.paddle.com'
    : 'https://sandbox-api.paddle.com';
  const resp = await fetch(`${base}/subscriptions/${subscriptionId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${env.PADDLE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  return { ok: resp.ok, status: resp.status, data };
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const db = env.DB;

  let body;
  try { body = await request.json(); } catch (_) { body = {}; }
  const key = String(body.key || '').trim();
  const targetPlan = String(body.plan || '').trim().toLowerCase();

  // 1. Auth
  if (!key || !/^stk_[A-Za-z0-9]{20,}$/.test(key)) {
    return json({ error: 'missing_key', message: 'Provide key in body: { key: "stk_...", plan: "pro" }' }, 400);
  }
  const user = await db.prepare(
    'SELECT id, email, plan, paddle_subscription_id, paddle_customer_id FROM users WHERE api_key = ?'
  ).bind(key).first();
  if (!user) {
    return json({ error: 'invalid_key', message: 'API key not found.' }, 404);
  }

  // 2. Validate target plan
  const target = PLAN_TO_PRICE[targetPlan];
  if (!target) {
    return json({
      error: 'invalid_plan',
      message: `Plan "${targetPlan}" is not available. Use 'hobby' or 'pro'.`,
    }, 400);
  }

  // 3. Must already have a Paddle subscription to change plan
  if (!user.paddle_subscription_id) {
    return json({
      error: 'no_subscription',
      message: 'You do not have an active Paddle subscription. Use /pricing to start one.',
      fallback_url: 'https://api.sitetrace.it.com/pricing',
    }, 400);
  }

  // 4. Idempotent: already on this plan, no-op
  if (user.plan === targetPlan) {
    return json({
      ok: true,
      already: true,
      message: `You are already on the ${targetPlan} plan.`,
      plan: targetPlan,
      daily_quota: PLAN_QUOTAS[targetPlan],
    });
  }

  // 5. PATCH Paddle subscription
  if (!env.PADDLE_API_KEY) {
    return json({ error: 'not_configured', message: 'PADDLE_API_KEY missing in env.' }, 503);
  }

  const { ok, status, data } = await paddlePatchSubscription(env, user.paddle_subscription_id, {
    items: [{ price_id: target.price_id, quantity: 1 }],
    proration_billing_mode: 'prorated_immediately',
  });

  if (!ok) {
    return json({
      error: 'paddle_update_failed',
      message: data?.error?.detail || data?.error?.message || `Paddle returned ${status}`,
      paddle_status: status,
      paddle_error_code: data?.error?.code,
    }, 502);
  }

  // 6. Mirror the change in D1 immediately (don't wait for webhook — gives
  //    the dashboard a snappy UX). The webhook will eventually fire and
  //    set the same values; this just races ahead.
  const newQuota = PLAN_QUOTAS[targetPlan];
  await db.prepare(
    `UPDATE users
        SET plan = ?,
            daily_quota = ?,
            status = 'active',
            updated_at = ?
      WHERE id = ?`
  ).bind(targetPlan, newQuota, Date.now(), user.id).run();

  return json({
    ok: true,
    plan: targetPlan,
    daily_quota: newQuota,
    subscription_id: user.paddle_subscription_id,
    proration: data?.data?.next_transaction?.details?.totals || null,
    message: `Plan changed to ${targetPlan}. Prorated charge applied immediately to your saved card.`,
  });
}

// OPTIONS preflight for CORS
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}
