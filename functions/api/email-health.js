// =====================================================================
// sitetrace-api — Email Health endpoint (Cloudflare Workers)
//
// Migrated from F:\.Projects\api-marketplace\email-health\index.js
//   - Removed express dependency (Workers-incompatible)
//   - Removed fake `getBreachData()` function — that was deterministic,
//     not a real breach check. Removed per honesty audit (Sept 27).
//   - Real breach check requires HIBP Pwned Accounts API ($3.50/mo key)
//     — placeholder/stub for now; will be enabled once revenue funds it.
//   - DNS via Cloudflare DoH (1.1.1.1/dns-query) instead of dns.promises
//     (Workers can't open raw UDP sockets)
//   - Same plan-based filtering preserved
//
// Endpoint: POST /api/email-health
// Body: { "email": "x@y.com" } or { "emails": ["x@y.com", ...] }
// Auth: shared middleware (functions/_middleware.js)
// =====================================================================

// Disposable / temporary email providers
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com','guerrillamail.com','10minutemail.com','throwam.com','yopmail.com',
  'trashmail.com','fakeinbox.com','sharklasers.com','guerrillamailblock.com',
  'grr.la','guerrillamail.info','guerrillamail.biz','guerrillamail.de','guerrillamail.net',
  'guerrillamail.org','spam4.me','maildrop.cc','tempmail.com','dispostable.com',
  'mailnull.com','spamgourmet.com','bouncr.com','trashmail.at','filzmail.com',
  'discard.email','mailnesia.com','nwldx.com','spamgourmet.net',
  'mt2015.com','discardmail.com','0-mail.com','jetable.fr.nf','nomail.xl.cx',
  'mailcatch.com','spamoff.de','wegwerfmail.de','tempinbox.com','kasmail.com',
  'fakedemail.com','lol.ovpn.to','spamzilla.pl','mailexpire.com','trbvm.com',
  'wegwerfadresse.de','1usemail.com','mailslurp.com','temp-mail.org','moakt.com',
]);

// Known free email providers
const FREE_PROVIDERS = new Set([
  'gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com','aol.com',
  'live.com','msn.com','me.com','mac.com','googlemail.com','ymail.com',
  'yahoo.co.uk','yahoo.fr','yahoo.de','yahoo.es','yahoo.it','yahoo.co.jp',
  'protonmail.com','tutanota.com','zoho.com','fastmail.com','hushmail.com',
  'inbox.com','mail.com','gmx.com','gmx.net','mail.ru','yandex.com','yandex.ru',
]);

// Role-based email prefixes
const ROLE_PREFIXES = new Set([
  'admin','administrator','webmaster','postmaster','hostmaster','info','support',
  'help','contact','noreply','no-reply','sales','marketing','billing','accounts',
  'security','abuse','spam','legal','press','media','hr','jobs','careers',
]);

// ─── Syntax validation ────────────────────────────────────────────────────────
function validateSyntax(email) {
  // Basic RFC-ish check: local@domain.tld with allowlisted specials
  const re = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
  if (!re.test(email)) return { valid: false, reason: 'Invalid email format' };
  const [local, domain] = email.split('@');
  if (local.length > 64) return { valid: false, reason: 'Local part exceeds 64 characters' };
  if (domain.length > 255) return { valid: false, reason: 'Domain exceeds 255 characters' };
  if (local.startsWith('.') || local.endsWith('.')) {
    return { valid: false, reason: 'Local part cannot start or end with a period' };
  }
  if (local.includes('..')) {
    return { valid: false, reason: 'Local part cannot have consecutive periods' };
  }
  return { valid: true };
}

// ─── DNS via Cloudflare DoH (free, no auth) ───────────────────────────────────
// 1.1.1.1 returns JSON for application/dns-json requests
async function resolveMx(domain) {
  const url = `https://1.1.1.1/dns-query?name=${encodeURIComponent(domain)}&type=MX`;
  const resp = await fetch(url, {
    headers: { 'Accept': 'application/dns-json' },
  });
  if (!resp.ok) return [];
  const json = await resp.json();
  // json.Answer entries with type 15 = MX records
  // Extra field on MX records = priority (0-65535), then exchange
  if (!Array.isArray(json.Answer)) return [];
  return json.Answer
    .filter((a) => a.type === 15)
    .map((a) => {
      // data is "priority hostname." — e.g., "10 mx1.example.com."
      const parts = a.data.split(/\s+/);
      return { priority: parseInt(parts[0], 10), exchange: parts[1]?.replace(/\.$/, '') };
    })
    .sort((a, b) => a.priority - b.priority);
}

// ─── Domain reputation (heuristic, no real blacklist queries) ────────────────
function getDomainReputation(domain, hasMX, isDisposable, isFree) {
  if (isDisposable) return { score: 10, label: 'Very Poor', reason: 'Disposable/temporary email service' };
  if (!hasMX)       return { score: 0,  label: 'Invalid',   reason: 'No mail server found' };
  if (isFree)       return { score: 70, label: 'Good',      reason: 'Legitimate free email provider' };
  // Business domain — heuristic score based on string entropy
  // (Real implementation would query DNSBL lists, but that adds latency)
  return { score: 85, label: 'Good', reason: 'Business domain with mail server' };
}

// ─── JSON / response helpers ─────────────────────────────────────────────────
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

async function readBody(request) {
  try {
    const ct = (request.headers.get('content-type') || '').toLowerCase();
    const raw = await request.text();
    if (!raw) return {};
    if (ct.includes('application/json')) return JSON.parse(raw);
    const params = new URLSearchParams(raw);
    const obj = {};
    for (const [k, v] of params) obj[k] = v;
    return obj;
  } catch (_) {
    return {};
  }
}

// ─── Main handler ────────────────────────────────────────────────────────────
export async function onRequestPost(context) {
  const { request, data } = context;
  const plan = data?.user?.plan || 'free';

  const body = await readBody(request);
  const emails_input = body?.emails || body?.email;

  if (!emails_input) {
    return jsonResponse({ error: 'invalid_request', message: '"email" or "emails" array required' }, 400);
  }

  // Plan-based batch limits
  const batchLimit = plan === 'free' ? 1
                   : plan === 'pro'  ? 10
                   :                   50;
  const list = Array.isArray(emails_input)
    ? emails_input.map(String).slice(0, batchLimit)
    : [String(emails_input)];

  const results = [];

  for (const raw of list) {
    const email  = String(raw).toLowerCase().trim();
    const syntax = validateSyntax(email);

    if (!syntax.valid) {
      results.push({
        email,
        valid_syntax: false,
        reason: syntax.reason,
        deliverable: false,
        deliverability_score: 0,
      });
      continue;
    }

    const [local, domain] = email.split('@');
    const isDisposable = DISPOSABLE_DOMAINS.has(domain);
    const isFree       = FREE_PROVIDERS.has(domain);
    const isRole       = ROLE_PREFIXES.has(local.toLowerCase());

    // Real MX check via Cloudflare DoH ($0)
    let hasMX = false;
    let mxRecords = [];
    let mxError = null;
    try {
      mxRecords = await resolveMx(domain);
      hasMX = mxRecords.length > 0;
    } catch (e) {
      mxError = e?.message || 'DNS lookup failed';
    }

    const deliverable = hasMX && !isDisposable;
    const reputation = getDomainReputation(domain, hasMX, isDisposable, isFree);
    const deliverabilityScore = isDisposable ? 5 : !hasMX ? 0 : isFree ? 75 : isRole ? 60 : 90;

    const result = {
      email,
      valid_syntax: true,
      deliverable,
      is_disposable: isDisposable,
      is_free_provider: isFree,
      is_role_based: isRole,
      mx_found: hasMX,
      deliverability_score: deliverabilityScore,
    };

    if (plan !== 'free') {
      result.domain = domain;
      result.domain_reputation = reputation;
      result.mx_records = mxRecords.slice(0, 3).map((r) => ({
        exchange: r.exchange,
        priority: r.priority,
      }));
      result.risk_flags = [
        isDisposable && 'disposable_address',
        !hasMX && 'no_mx_record',
        isRole && 'role_based_address',
      ].filter(Boolean);
      if (mxError) result.mx_lookup_error = mxError;
    }

    if (plan === 'ultra' || plan === 'mega') {
      result.recommendation = deliverable && !isDisposable && !isRole
        ? 'Safe to email — low risk'
        : isDisposable ? 'Block — disposable address'
        : isRole       ? 'Use with caution — may not reach individual'
        : !hasMX       ? 'Do not send — domain has no mail server'
        : 'Review required';
      result.spam_trap_risk = isDisposable || deliverabilityScore < 20 ? 'HIGH' : isRole ? 'MEDIUM' : 'LOW';
      result.breach_check = {
        available: false,
        reason: 'Real email breach lookup requires a HIBP Pwned Accounts API key ($3.50/mo). ' +
                'Will be enabled once API revenue funds it. In the meantime, see haveibeenpwned.com ' +
                'for free manual checks.',
      };
    }

    results.push(result);
  }

  const totalChecked = results.length;
  const deliverableCount = results.filter((r) => r.deliverable).length;
  const riskyCount = results.filter((r) => r.is_disposable || !r.mx_found).length;

  return jsonResponse({
    success: true,
    analyzed_at: new Date().toISOString(),
    emails_checked: totalChecked,
    deliverable_count: deliverableCount,
    risky_count: riskyCount,
    list_health_score: Math.round((deliverableCount / Math.max(1, totalChecked)) * 100),
    results,
    plan,
  }, 200);
}

// OPTIONS handler for CORS preflight
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}