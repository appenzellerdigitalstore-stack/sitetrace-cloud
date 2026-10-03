// =====================================================================
// sitetrace-api — Signup (free tier)
//
// POST /api/signup   body: { email: "you@example.com" }
//
// Creates a free-tier user (1,000 calls/day) and returns the API key.
// One signup per email. Disposable / throwaway providers (10minutemail,
// Mailinator, etc.) are rejected with 400 to block the cheapest abuse
// vector (scripted signups). Email verification is NOT required —
// abuse mitigation is layered: IP rate-limit + disposable block +
// per-user daily quota.
//
// If the user is already in the DB, return the existing key (so
// they can re-find it without a separate login flow on the free
// tier).
// =====================================================================

import { isDisposableEmail } from './_lib/disposable-emails.js';

function newApiKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let s = 'stk_';
  for (const b of bytes) s += chars[b % chars.length];
  return s;
}

function newId() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const db = env.DB;

  let body;
  try { body = await request.json(); } catch (_) { body = {}; }
  const email = String((body && body.email) || '').trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email) || email.length > 254) {
    return json({ error: 'invalid_email', message: 'Provide a valid email address.' }, 400);
  }

  // Block disposable / throwaway providers. The error message is
  // deliberately generic (we don't want to tell abusers exactly which
  // list they're on) — they get the same shape as 'invalid_email' but
  // a distinct error code so we can measure the abuse rate.
  if (isDisposableEmail(email)) {
    return json({
      error: 'disposable_email_blocked',
      message: 'Please use a permanent email address. Free throwaway providers are not allowed.',
    }, 400);
  }

  // Existing user? Return their key.
  const existing = await db.prepare(
    'SELECT id, api_key, plan, status, daily_quota, created_at FROM users WHERE email = ?'
  ).bind(email).first();

  if (existing) {
    return json({
      ok: true,
      already: true,
      user: {
        email,
        api_key: existing.api_key,
        plan: existing.plan,
        status: existing.status,
        daily_quota: existing.daily_quota,
        dashboard_url: 'https://api.sitetrace.it.com/dashboard?key=' + existing.api_key,
      },
      message: 'You already have an account. Here is your API key — keep it safe. Reset at /dashboard.',
    });
  }

  const now = Math.floor(Date.now() / 1000);
  const id = newId();
  const apiKey = newApiKey();
  const dailyQuota = 1000; // free tier with key: 1k/day

  await db.prepare(
    `INSERT INTO users (id, email, api_key, plan, status, daily_quota, created_at, updated_at)
     VALUES (?, ?, ?, 'free', 'active', ?, ?, ?)`
  ).bind(id, email, apiKey, dailyQuota, now, now).run();

  return json({
    ok: true,
    already: false,
    user: {
      email,
      api_key: apiKey,
      plan: 'free',
      status: 'active',
      daily_quota: dailyQuota,
      dashboard_url: 'https://api.sitetrace.it.com/dashboard?key=' + apiKey,
    },
    message: 'Welcome. Your free API key has 1,000 calls/day. Upgrade for more at /pricing.',
  });
}
