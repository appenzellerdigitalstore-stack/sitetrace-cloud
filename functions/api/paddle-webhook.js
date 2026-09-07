// =====================================================================
// sitetrace-api — Paddle webhook
//
// POST /api/paddle-webhook
//
// Receives subscription events from Paddle and updates the user record.
// We support these events:
//   - subscription.created   → set plan, daily_quota, paddle_subscription_id
//   - subscription.updated   → refresh plan/quota
//   - subscription.canceled  → mark cancelled, set cancel_at
//   - subscription.expired   → flip to free + 1000/day
//
// Verification: Paddle signs the body with HMAC-SHA256. The signature
// is in `Paddle-Signature` header as `ts=...,h1=...`. We verify the
// ts is recent (<5 min) and the h1 matches HMAC(body+ts, PADDLE_WEBHOOK_SECRET).
//
// In dev / first deploy, set PADDLE_WEBHOOK_SECRET in CF Pages env
// vars. Without it, the endpoint will accept unsigned events (REJECT
// in production).
// =====================================================================

const PLAN_TO_QUOTA = {
  hobby:  1000,
  pro:    30000,
  volume: 200000,
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function utf8ToHex(s) {
  let h = '';
  for (let i = 0; i < s.length; i++) h += (s.charCodeAt(i) < 16 ? '0' : '') + s.charCodeAt(i).toString(16);
  return h;
}

async function verifyPaddleSignature(secret, header, body) {
  if (!secret) return false;
  // Header format: ts=1700000000;h1=abc123...
  const m = header.match(/ts=(\d+).*?h1=([a-f0-9]+)/i);
  if (!m) return false;
  const ts = parseInt(m[1], 10);
  const h1 = m[2];
  // Reject if older than 5 min (replay protection)
  if (Math.abs(Date.now() / 1000 - ts) > 300) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const signedPayload = ts + ':' + body;
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(signedPayload));
  const hex = Array.from(new Uint8Array(sig), b => b.toString(16).padStart(2, '0')).join('');
  // Constant-time-ish compare
  if (hex.length !== h1.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ h1.charCodeAt(i);
  return diff === 0;
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const raw = await request.text();
  const sig = request.headers.get('Paddle-Signature') || '';

  // Verify signature. In test mode, Paddle may not sign — allow
  // through only if PADDLE_WEBHOOK_SECRET is unset (dev) OR header
  // is present and valid.
  const secret = env.PADDLE_WEBHOOK_SECRET;
  if (secret) {
    const ok = await verifyPaddleSignature(secret, sig, raw);
    if (!ok) return json({ error: 'invalid_signature' }, 401);
  } else {
    // In dev with no secret, accept all (and warn in logs)
    console.warn('PADDLE_WEBHOOK_SECRET not set; accepting unsigned event');
  }

  let event;
  try { event = JSON.parse(raw); } catch (_) {
    return json({ error: 'invalid_json' }, 400);
  }

  const eventType = event.event_type || event.alert_name;
  const data = event.data || {};
  const db = env.DB;

  // We send `passthrough` on checkout with the user's email and the
  // plan they picked, so we can correlate without a Customer ID.
  const passthrough = data.custom_data?.passthrough
    || data.passthrough
    || null;
  let email = null, plan = null;
  if (passthrough) {
    try {
      const pt = typeof passthrough === 'string' ? JSON.parse(passthrough) : passthrough;
      email = pt.email || null;
      plan = pt.plan || null;
    } catch (_) {}
  }
  if (!email && data.customer?.email) email = data.customer.email;
  if (!plan) {
    // Map Paddle price_id → plan. Set these in Paddle dashboard
    // per environment. Format: pri_xxx_yyy.
    const priceId = data.items?.[0]?.price?.id || data.subscription_plan_id;
    if (priceId === env.PADDLE_PRICE_HOBBY)  plan = 'hobby';
    if (priceId === env.PADDLE_PRICE_PRO)    plan = 'pro';
    if (priceId === env.PADDLE_PRICE_VOLUME) plan = 'volume';
  }

  const subId = data.id || data.subscription_id || null;
  const customerId = data.customer_id || data.customer?.id || null;
  const now = Math.floor(Date.now() / 1000);

  if (eventType === 'subscription.created' || eventType === 'subscription.updated' || eventType === 'subscription.activated') {
    if (!email || !plan || !PLAN_TO_QUOTA[plan]) {
      return json({ error: 'unparseable_event', email, plan, eventType }, 400);
    }
    const quota = PLAN_TO_QUOTA[plan];
    // Upsert the user
    const existing = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    if (existing) {
      await db.prepare(
        `UPDATE users SET plan = ?, status = 'active', daily_quota = ?, paddle_customer_id = ?, paddle_subscription_id = ?, cancel_at = NULL, updated_at = ? WHERE id = ?`
      ).bind(plan, quota, customerId, subId, now, existing.id).run();
    } else {
      // First-time paid user without a free signup. Create the row.
      const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      let apiKey = 'stk_';
      for (const b of bytes) apiKey += chars[b % chars.length];
      await db.prepare(
        `INSERT INTO users (id, email, api_key, plan, status, daily_quota, paddle_customer_id, paddle_subscription_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`
      ).bind(id, email, apiKey, plan, quota, customerId, subId, now, now).run();
    }
    return json({ ok: true, action: 'upserted', plan, email });
  }

  if (eventType === 'subscription.canceled' || eventType === 'subscription.cancelled') {
    if (!email) return json({ error: 'no_email' }, 400);
    const cancelAt = data.current_period_end ? Math.floor(new Date(data.current_period_end).getTime() / 1000) : now;
    await db.prepare(
      `UPDATE users SET status = 'cancelled', cancel_at = ?, updated_at = ? WHERE email = ?`
    ).bind(cancelAt, now, email).run();
    return json({ ok: true, action: 'cancelled', email, cancel_at: cancelAt });
  }

  if (eventType === 'subscription.expired' || eventType === 'subscription.paused') {
    if (!email) return json({ error: 'no_email' }, 400);
    await db.prepare(
      `UPDATE users SET plan = 'free', status = 'active', daily_quota = 1000, paddle_subscription_id = NULL, cancel_at = NULL, updated_at = ? WHERE email = ?`
    ).bind(now, email).run();
    return json({ ok: true, action: 'expired_or_paused', email });
  }

  // Other events: ack and ignore
  return json({ ok: true, action: 'ignored', event: eventType });
}
