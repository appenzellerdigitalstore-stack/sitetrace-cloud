// =====================================================================
// sitetrace-api — Account info
//
// GET /api/account?key=stk_...      — returns key, plan, status, today's usage
//                                     per endpoint, and a link to the dashboard
//
// Auth: this endpoint requires the key (in query or Bearer). It does
// NOT charge against the user's quota — it's a meta-call.
// =====================================================================

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

export async function onRequestGet(context) {
  const { env, request } = context;
  const db = env.DB;
  const url = new URL(request.url);
  const auth = request.headers.get('Authorization') || '';
  const bearer = auth.match(/^Bearer\s+(stk_[A-Za-z0-9]{20,})$/);
  const key = bearer ? bearer[1] : url.searchParams.get('key');
  if (!key || !/^stk_[A-Za-z0-9]{20,}$/.test(key)) {
    return json({ error: 'missing_key', message: 'Provide ?key=stk_... or Authorization: Bearer stk_...' }, 400);
  }

  const user = await db.prepare(
    'SELECT id, email, api_key, plan, status, daily_quota, created_at, paddle_subscription_id, paddle_customer_id FROM users WHERE api_key = ?'
  ).bind(key).first();
  if (!user) {
    return json({ error: 'invalid_key', message: 'API key not found.' }, 404);
  }

  const date = new Date().toISOString().slice(0, 10);
  const usageRows = await db.prepare(
    'SELECT endpoint, count FROM usage WHERE user_id = ? AND date = ?'
  ).bind(user.id, date).all();

  const usage = {};
  for (const r of (usageRows.results || [])) {
    usage[r.endpoint] = r.count;
  }

  return json({
    user: {
      email: user.email,
      api_key: user.api_key,
      plan: user.plan,
      status: user.status,
      daily_quota: user.daily_quota,
      created_at: user.created_at,
      // Returned so the checkout script can pass paddle_subscription_id
      // to Paddle.Checkout.open() — without it, Paddle sandbox sometimes
      // treats the upgrade as a brand-new subscription instead of a plan
      // change, charging the full new price AND leaving the old one
      // running. See pricing.html checkout() for the usage.
      paddle_subscription_id: user.paddle_subscription_id || null,
      paddle_customer_id: user.paddle_customer_id || null,
    },
    usage: {
      date,
      by_endpoint: usage,
      total: Object.values(usage).reduce((a, b) => a + b, 0),
    },
    dashboard_url: 'https://api.sitetrace.it.com/dashboard?key=' + key,
    upgrade_url: 'https://api.sitetrace.it.com/pricing',
  });
}
