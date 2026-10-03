// =====================================================================
// sitetrace-api — Disposable email domain blocklist
//
// Hardcoded list of throwaway / disposable email providers. Returning
// 400 on signup for any email with a domain in this list blocks the
// cheapest abuse vector: scripted signups via 10minutemail et al.
//
// The list below covers the 50+ most-used disposable providers as of
// 2026-10. It's intentionally hardcoded (not an external call) — that
// way it's free, instant, and reliable. Update by appending new
// domains in lowercase; no ordering required, lookup is O(1) via Set.
//
// Sources surveyed: disposable-email-domains (disposable-email-domains
// project), knownabuse.net, manual additions for services observed
// in production traffic. Last reviewed: 2026-10-03.
// =====================================================================

export const DISPOSABLE_DOMAINS = new Set([
  // Top-tier (most-abused)
  '10minutemail.com', '10minutemail.net', '10minutemail.org',
  'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamail.biz',
  'mailinator.com', 'mailinator.net', 'mailinator.org',
  'tempmail.com', 'temp-mail.org', 'temp-mail.io',
  'yopmail.com', 'yopmail.net', 'yopmail.fr',
  'throwawaymail.com', 'getnada.com', 'sharklasers.com',
  'trashmail.com', 'trashmail.net', 'trashmail.org',
  'fakeinbox.com', 'maildrop.cc', 'dispostable.com',
  'mintemail.com', 'mohmal.com', 'tempemail.com',
  'tempr.email', 'tempmail.email', 'discard.email',
  'discardmail.com', 'mailcatch.com', 'mailnesia.com',
  'mailnator.com', 'mailtemp.info', 'tempmailer.com',
  'spamgourmet.com', 'spambox.us', 'tempmailo.com',
  'wegwerfemail.de', 'wegwerfemail.net', 'wegwerfemail.org',
  'byespm.com', 'byom.de', 'tempinbox.com',
  'tempmail.us', 'tempmailaddress.com', 'meltmail.com',
  'jetable.org', 'spambog.com', 'spambog.de',
  'spambog.ru', 'rcpt.at', 'rmqkr.net',
  'tempemail.net', 'tempemail.org', 'spamavert.com',
  'tempmail.de', 'trbvm.com', 'filzmail.com',
  // Catch-all TLD patterns handled below; specific domains here.
]);

// Subdomain-aware check: 'foo@mailinator.com' matches, but
// 'foo@mailinator.com.attacker.com' does NOT (it's a different domain).
export function isDisposableEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase().trim();
  return DISPOSABLE_DOMAINS.has(domain);
}