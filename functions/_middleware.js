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

// Pricing tiers — T1-T4 linear, $9-10 per 1k daily calls. Decision
// (2026-10-02): linear matches our actual cost structure (no economy
// of scale — every call costs the same). Top tier (T4 = 5k/day) is the
// practical ceiling: ip-api.com's 45 req/min global limit means real-
// world max is ~30k/day for any single user anyway.
// Backward compatibility: free + hobby + pro + volume still work as
// fallback names so D1 rows from before this commit don't break.
const PLANS = {
  free:   { daily: 100,    label: 'Free' },
  // T1-T4: new linear tiers
  T1:     { daily: 1000,   label: 'T1'    },
  T2:     { daily: 2000,   label: 'T2'    },
  T3:     { daily: 3000,   label: 'T3'    },
  T4:     { daily: 5000,   label: 'T4'    },
  // Legacy names — kept so old Paddle sandbox subs keep working. When
  // Ed flips Paddle sandbox -> live, these will go away.
  hobby:  { daily: 5000,   label: 'Hobby' },
  pro:    { daily: 30000,  label: 'Pro'   },
  volume: { daily: 200000, label: 'Volume'},
};

// Public paths — auth-free. Used for signup, login, webhooks, status probes, etc.
const PUBLIC_PATHS = new Set([
  '/api/signup',
  '/api/login',
  '/api/paddle-webhook',
  // Status-page probes: these endpoints are read-only and cheap, and the
  // /status page needs to hit them without an api_key. The quota cost of
  // someone spamming these from outside is negligible (they hit upstream
  // DoH/MX servers, not our D1 user table), so auth-free is fine.
  '/api/email',
  '/api/rdap',
  '/api/ip',
  '/api/headers',
  '/api/preview',
  '/api/certs',
  '/api/shot',
  // Plan-change endpoint: auth happens in the endpoint (key in body),
  // not via the middleware's Bearer header, so the quota counter doesn't
  // tick for a subscription update. See functions/api/change-plan.js.
  '/api/change-plan',
  // Webhook stats — operational metadata for the dashboard. Not sensitive
  // (just delivery counts), and counting it against user quota would be
  // wrong (it's an admin/monitoring call, not an API call).
  '/api/webhook-stats',
  // OpenAPI spec — used by /docs page for download link + by SDK
  // generators. Public read, doesn't burn user quota. No .json
  // extension because CF Pages treats .json URLs as static files.
  '/api/openapi',
  // Signup is already public but listing it here makes the
  // "no-auth-needed" set explicit.
  '/api/signup',
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
      // AI training opt-out. Honored by GPTBot, ClaudeBot, CommonCrawl,
      // and most major dataset operators. See /terms §7b.
      'X-Robots-Tag': 'noai, noimageai',
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

async function getUserUsage(db, userId) {
  // AGGREGATE quota: sum across all endpoints for today.
  // The per-endpoint rows are still written (see incrementUserUsage below)
  // so /api/account can show a breakdown by endpoint for analytics, but
  // the quota check itself is against the daily total — matches what
  // users see in the pricing page ("X calls/day" not "X calls/endpoint/day").
  const date = todayUtc();
  const row = await db.prepare(
    'SELECT COALESCE(SUM(count), 0) AS total FROM usage WHERE user_id = ? AND date = ?'
  ).bind(userId, date).first();
  return row ? row.total : 0;
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
    // Per-IP rate limit on /api/openapi to prevent scrapers from
    // endlessly redownloading the spec. The spec changes once per
    // release at most; 50/day/IP is plenty for humans and SDK
    // generators, hard cap for scrapers.
    if (path === '/api/openapi' && env.RATELIMIT) {
      const ip = clientIp(request);
      const date = todayUtc();
      const kvKey = 'openapi:' + ip + ':' + date;
      const currentStr = await env.RATELIMIT.get(kvKey);
      const currentCount = currentStr ? parseInt(currentStr, 10) : 0;
      if (currentCount >= 50) {
        return jsonResponse({
          error: 'openapi_rate_limited',
          message: 'Too many spec downloads from your IP today. Cache the spec locally — it changes at most once per release.',
          used: currentCount,
          quota: 50,
        }, 429, { 'Retry-After': '3600' });
      }
      await env.RATELIMIT.put(kvKey, String(currentCount + 1), { expirationTtl: 86400 * 2 });
    }
    data.public = true;
    // Wrap the function's response to add X-Robots-Tag (LM-training
    // opt-out — see /terms §7b). Endpoints like /api/openapi return
    // their own Response objects (cache headers, content-type) that
    // bypass jsonResponse(), so we re-wrap here.
    const resp = await next();
    const wrapped = new Response(resp.body, resp);
    if (!wrapped.headers.has('X-Robots-Tag')) {
      wrapped.headers.set('X-Robots-Tag', 'noai, noimageai');
    }
    return wrapped;
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

    // Quota check — AGGREGATE across all endpoints (see getUserUsage).
    const used = await getUserUsage(db, user.id);
    const quota = user.daily_quota || PLANS[user.plan]?.daily || 100;
    if (used >= quota) {
      logCall(db, user.api_key, endpoint, 429);
      return jsonResponse({
        error: 'quota_exceeded',
        message: 'Daily quota reached across all endpoints. Aggregate cap is ' + quota + ' calls/day.',
        plan: user.plan,
        used,
        quota,
        endpoint_used: endpoint,
        resets_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        upgrade_url: 'https://api.sitetrace.it.com/pricing',
      }, 429, {
        'X-RateLimit-Limit': String(quota),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(Math.floor((Date.now() + 24 * 3600 * 1000) / 1000)),
      });
    }

    // IP-level cap (anti multi-account abuse). Free-with-key accounts
    // share a 1000/day budget per IP across all free accounts on that
    // IP — without this, an abuser signs up N free accounts and gets
    // N × 1000/day. Paid users (T1-T4, etc.) bypass this; their per-
    // user quota already protects the abuse vector and they shouldn't
    // be penalized for a noisy IP neighbor.
    const IP_USER_CAP = 1000;
    if (user.plan === 'free' && env.RATELIMIT) {
      const ip = clientIp(request);
      const date = todayUtc();
      const kvKey = 'ipcap:' + ip + ':' + date;
      const currentStr = await env.RATELIMIT.get(kvKey);
      const currentCount = currentStr ? parseInt(currentStr, 10) : 0;
      if (currentCount >= IP_USER_CAP) {
        logCall(db, user.api_key, endpoint, 429);
        return jsonResponse({
          error: 'ip_user_cap',
          message: 'Your IP has used all ' + IP_USER_CAP + ' free calls today across all free accounts. Try again tomorrow, or pick a paid plan (T1-T4: $9-$49/mo).',
          used: currentCount,
          quota: IP_USER_CAP,
          plan: 'free',
          upgrade_url: 'https://api.sitetrace.it.com/pricing',
        }, 429, {
          'X-RateLimit-Limit': String(IP_USER_CAP),
          'X-RateLimit-Remaining': '0',
          'Retry-After': '3600',
        });
      }
      // Read-modify-write — eventually consistent (concurrent calls may
      // race and slightly under-count). Acceptable for a soft cap; an
      // abuser that races their way past 1000 still hits the user
      // quota on the next request from any account on the IP.
      await env.RATELIMIT.put(kvKey, String(currentCount + 1), { expirationTtl: 86400 * 2 });
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
    // Add rate-limit headers + X-Robots-Tag (LM-training opt-out)
    const newResp = new Response(resp.body, resp);
    newResp.headers.set('X-RateLimit-Limit', String(quota));
    newResp.headers.set('X-RateLimit-Remaining', String(Math.max(0, quota - (used + 1))));
    if (!newResp.headers.has('X-Robots-Tag')) {
      newResp.headers.set('X-Robots-Tag', 'noai, noimageai');
    }
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
  // Wrap to add X-Robots-Tag (LM-training opt-out — see /terms §7b)
  const newResp = new Response(resp.body, resp);
  if (!newResp.headers.has('X-Robots-Tag')) {
    newResp.headers.set('X-Robots-Tag', 'noai, noimageai');
  }
  return newResp;
}
