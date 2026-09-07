-- =====================================================================
-- sitetrace-api initial schema
-- Run with: npm run db:migrate (production) or npm run db:migrate:local
-- =====================================================================

-- Users — one row per signup. api_key is the bearer token the customer
-- uses in `Authorization: Bearer stk_...` or `?key=stk_...`.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  api_key TEXT UNIQUE NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',          -- 'free' | 'hobby' | 'pro' | 'volume'
  status TEXT NOT NULL DEFAULT 'active',     -- 'active' | 'cancelled' | 'expired'
  paddle_customer_id TEXT,
  paddle_subscription_id TEXT,
  daily_quota INTEGER NOT NULL DEFAULT 100,  -- per-day API call limit
  cancel_at INTEGER,                         -- unix ts when subscription ends
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_api_key ON users(api_key);
CREATE INDEX IF NOT EXISTS idx_users_paddle ON users(paddle_subscription_id);

-- Daily usage — one row per (user, endpoint, date). Incremented on
-- every authenticated call. Reset by the (user, endpoint, date)
-- uniqueness on a new day.
CREATE TABLE IF NOT EXISTS usage (
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  date TEXT NOT NULL,                        -- YYYY-MM-DD
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, endpoint, date),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_usage_user_date ON usage(user_id, date);

-- IP rate-limits for the free, no-key tier. One row per (ip, date).
-- 100 calls/day per IP. Same approach as user quotas; the middleware
-- increments + checks atomically.
CREATE TABLE IF NOT EXISTS ip_rate_limits (
  ip TEXT NOT NULL,
  date TEXT NOT NULL,                        -- YYYY-MM-DD
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, date)
);

-- Audit log — every API call, for debugging abuse + giving the user
-- a usage view. Keep light: just (user_or_ip, endpoint, ts, status).
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject TEXT NOT NULL,                     -- api_key (logged) or ip (free)
  endpoint TEXT NOT NULL,
  status INTEGER NOT NULL,                   -- HTTP status returned
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calls_subject_ts ON calls(subject, ts);
CREATE INDEX IF NOT EXISTS idx_calls_ts ON calls(ts);
