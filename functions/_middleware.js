// =====================================================================
// sitetrace-api — Auth + rate-limit middleware
//
// Runs on every /api/* request (configured in public/_routes.json).
// Decides whether the caller is:
//   1. Free-tier (no key) — IP rate-limit, 100/day, max 1 req/sec
//   2. Paid-tier (Bearer stk_...) — quota check, plan-based daily cap
//   3. Public (signup, login, paddle-webhook, account/me) — no auth
//
// On success, attaches `context.data.user` or `context.data.free = true`
// so the endpoint function can read it.
// =====================================================================

const PLANS = {
  free:   { daily: 100,  label: 'Free'   },
  hobby:  { daily: 5000, label: 'Hobby'  },
  pro:    { daily: 30000, label: 'Pro'   },
  volume: { daily: 200000, label: 'Volume' },
};

// Public paths — auth-free. Used for signup, login, webhooks, etc.
const PUBLIC_PATHS = new Set([
  '/api/signup',
  '/api/login',
  '/api/paddle-webhook',
]);

// Static-asset paths under /api/ (e.g. swagger.json) — also public.
function isPublic(path) {
  if (PUBLIC_PATHS.has(path)) return true;
  if (path.startsWith('/api/og/')) return true; // dynamic OG images are public
  return false;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function jsonResponse(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    }, extraHeaders || {}),
  });
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP')
      || request.headers.get('X-Forwarded-For')?.split(',')[0].trim()
      || '0.0.0.0';
}

function extractKey(request, url) {
  // 1. Authorization: Bearer stk_...
  const auth = request.headers.get('Authorization');
  if (auth) {
    const m = auth.match(/^Bearer\s+(stk_[A-Za-z0-9]{20,})$/);
    if (m) return m[1];
  }
  // 2. ?key=stk_... (handy for curl)
  const k = url.searchParams.get('key');
  if (k && /^stk_[A-Za-z0-9]{20,}$/.test(k)) return k;
  return null;
}

// ---------------------------------------------------------------------
// DB operations
// ---------------------------------------------------------------------

async function lookupUserByKey(db, apiKey) {
  return await db.prepare(
    'SELECT id, email, api_key, plan, status, daily_quota, cancel_at FROM users WHERE api_key = ?'
  ).bind(apiKey).first();
}

async function incrementUserUsage(db, userId, endpoint) {
  const date = todayUtc();
  // Upsert: insert or increment the (user, endpoint, date) row atomically.
  await db.prepare(
    `INSERT INTO usage (user_id, endpoint, date, count) VALUES (?, ?, ?, 1)
     ON CONFLICT(user_id, endpoint, date) DO UPDATE SET count = count + 1`
  ).bind(userId, endpoint, date).run();
}

async function getUserUsage(db, userId, endpoint) {
  const date = todayUtc();
  const row = await db.prepare(
    'SELECT count FROM usage WHERE user_id = ? AND endpoint = ? AND date = ?'
  ).bind(userId, endpoint, date).first();
  return row ? row.count : 0;
}

async function incrementIpLimit(db, ip) {
  const date = todayUtc();
  await db.prepare(
    `INSERT INTO ip_rate_limits (ip, date, count) VALUES (?, ?, 1)
     ON CONFLICT(ip, date) DO UPDATE SET count = count + 1`
  ).bind(ip, date).run();
}

async function getIpLimit(db, ip) {
  const date = todayUtc();
  const row = await db.prepare(
    'SELECT count FROM ip_rate_limits WHERE ip = ? AND date = ?'
  ).bind(ip, date).first();
  return row ? row.count : 0;
}

async function logCall(db, subject, endpoint, status) {
  try {
    await db.prepare(
      'INSERT INTO calls (subject, endpoint, status, ts) VALUES (?, ?, ?, ?)'
    ).bind(subject, endpoint, status, Date.now()).run();
  } catch (_) { /* logging is best-effort */ }
}

// ---------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------

export async function onRequest(context) {
  const { request, env, next, data } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS preflight — always allowed
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  // Only /api/* goes through auth. Everything else (docs site) is public.
  if (!path.startsWith('/api/')) {
    return next();
  }

  // Graceful degradation: if D1 is not yet configured, the API can't
  // authenticate or rate-limit. Return 503 with a clear message and
  // let the static site keep serving. This is a deployment-time
  // condition, not a runtime one.
  if (!env.DB) {
    return new Response(JSON.stringify({
      error: 'not_configured',
      message: 'The D1 database is not yet provisioned. See DEPLOY.md step 7. Static site is unaffected.',
    }), {
      status: 503,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Retry-After': '300',
      },
    });
  }

  // Public /api/ endpoints (signup, login, webhooks, dynamic OG)
  if (isPublic(path)) {
    data.public = true;
    return next();
  }

  // Health endpoint is also public
  if (path === '/api/health' || path === '/api/status') {
    return next();
  }

  const db = env.DB;
  const endpoint = path.replace(/^\/api\//, '').split('/')[0]; // 'shot', 'ip', etc.
  const ip = clientIp(request);

  // Try API key first
  const apiKey = extractKey(request, url);
  if (apiKey) {
    const user = await lookupUserByKey(db, apiKey);
    if (!user) {
      logCall(db, 'invalid_key', endpoint, 401);
      return jsonResponse({
        error: 'invalid_key',
        message: 'API key not found. Check that you copied it correctly from the dashboard.',
        hint: 'Get a key at https://api.sitetrace.it.com/signup',
      }, 401);
    }
    if (user.status !== 'active') {
      logCall(db, user.api_key, endpoint, 403);
      return jsonResponse({
        error: 'subscription_inactive',
        message: 'Your subscription is ' + user.status + '. Update billing at https://api.sitetrace.it.com/dashboard',
      }, 403);
    }

    // Quota check
    const used = await getUserUsage(db, user.id, endpoint);
    const quota = user.daily_quota || PLANS[user.plan]?.daily || 100;
    if (used >= quota) {
      logCall(db, user.api_key, endpoint, 429);
      return jsonResponse({
        error: 'quota_exceeded',
        message: 'Daily quota reached for ' + endpoint + '.',
        plan: user.plan,
        used,
        quota,
        resets_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        upgrade_url: 'https://api.sitetrace.it.com/pricing',
      }, 429, {
        'X-RateLimit-Limit': String(quota),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(Math.floor((Date.now() + 24 * 3600 * 1000) / 1000)),
      });
    }

    // Charge the call
    await incrementUserUsage(db, user.id, endpoint);

    // Attach to context for the endpoint
    data.user = user;
    data.used = used + 1;
    data.quota = quota;
    data.charged = true;

    const resp = await next();
    logCall(db, user.api_key, endpoint, resp.status);
    // Add rate-limit headers
    const newResp = new Response(resp.body, resp);
    newResp.headers.set('X-RateLimit-Limit', String(quota));
    newResp.headers.set('X-RateLimit-Remaining', String(Math.max(0, quota - (used + 1))));
    return newResp;
  }

  // Free tier — IP rate limit
  const FREE_LIMIT = 100;
  const used = await getIpLimit(db, ip);
  if (used >= FREE_LIMIT) {
    logCall(db, 'ip:' + ip, endpoint, 429);
    return jsonResponse({
      error: 'free_tier_limit',
      message: 'You have used all ' + FREE_LIMIT + ' free calls today for this IP. Sign up for a free API key (1,000/day) or pick a paid plan.',
      used,
      quota: FREE_LIMIT,
      signup_url: 'https://api.sitetrace.it.com/signup',
    }, 429, {
      'X-RateLimit-Limit': String(FREE_LIMIT),
      'X-RateLimit-Remaining': '0',
      'Retry-After': '3600',
    });
  }

  await incrementIpLimit(db, ip);

  data.free = true;
  data.ip = ip;
  data.used = used + 1;
  data.quota = FREE_LIMIT;

  const resp = await next();
  logCall(db, 'ip:' + ip, endpoint, resp.status);
  return resp;
}
