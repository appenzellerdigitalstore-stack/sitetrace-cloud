// =====================================================================
// sitetrace-api — IP Reputation (wraps the existing sitetrace Worker)
//
// Endpoint: GET /api/ip?ip=1.2.3.4
//
// Same logic as the sitetrace /api/ip-reputation Worker, but
// re-implemented here to:
//   1. Not require a cross-project import (Pages Functions don't
//      share code across projects).
//   2. Stay self-contained so this repo can be deployed alone.
//
// Auth: shared middleware.
// =====================================================================

const DOH = 'https://cloudflare-dns.com/dns-query';
const GEO_API = 'http://ip-api.com/json';
const TIMEOUT_MS = 6000;

const DNSBLS = [
  { id: 'spamhaus_zen',   zone: 'zen.spamhaus.org',          label: 'Spamhaus ZEN' },
  { id: 'spamcop',        zone: 'bl.spamcop.net',            label: 'Spamcop' },
  { id: 'barracuda',      zone: 'b.barracudacentral.org',    label: 'Barracuda' },
  { id: 'cbl',            zone: 'cbl.abuseat.org',           label: 'CBL Abuseat' },
  { id: 'sorbs',          zone: 'dnsbl.sorbs.net',           label: 'SORBS' },
  { id: 'uceprotect_l1',  zone: 'uceprotectl1.dnsbl.org',    label: 'UCEPROTECT L1' },
  { id: 'psbl',           zone: 'psbl.surriel.com',          label: 'PSBL Surriel' },
];

function isValidIPv4(ip) {
  if (!ip || typeof ip !== 'string') return false;
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

function reverseIp(ip) { return ip.split('.').reverse().join('.'); }

async function queryDnsbl(ip, zone) {
  const host = `${reverseIp(ip)}.${zone}`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const resp = await fetch(
      `${DOH}?name=${encodeURIComponent(host)}&type=A`,
      { headers: { 'Accept': 'application/dns-json' }, signal: ctrl.signal }
    );
    clearTimeout(t);
    if (!resp.ok) return { listed: null, codes: [], error: `http_${resp.status}` };
    const data = await resp.json();
    if (data.Status === 3) return { listed: false, codes: [], error: null };
    if (data.Status !== 0) return { listed: null, codes: [], error: `dns_status_${data.Status}` };
    const answers = Array.isArray(data.Answer) ? data.Answer : [];
    const codes = answers
      .map(a => a.data)
      .filter(d => typeof d === 'string' && d.startsWith('127.0.0.'))
      .map(d => d.split('.').pop())
      .filter(c => c !== '0');
    return { listed: codes.length > 0, codes, error: null };
  } catch (e) {
    return { listed: null, codes: [], error: e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || 'error' };
  }
}

async function queryAllDnsbls(ip) {
  return await Promise.all(DNSBLS.map(async (d) => {
    const r = await queryDnsbl(ip, d.zone);
    return { id: d.id, label: d.label, listed: r.listed, codes: r.codes, error: r.error };
  }));
}

async function queryGeo(ip) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const resp = await fetch(
      `${GEO_API}/${encodeURIComponent(ip)}?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,proxy,hosting,mobile,query`,
      { signal: ctrl.signal }
    );
    clearTimeout(t);
    if (!resp.ok) return null;
    const data = await resp.json();
    if (data.status !== 'success') return null;
    return data;
  } catch (_) { return null; }
}

function computeScore(dnsbl, geo) {
  let score = 100;
  let listedCount = 0;
  let checkedCount = 0;
  for (const d of dnsbl) {
    if (d.listed === true) { listedCount += 1; score -= 10; }
    else if (d.listed === false) { checkedCount += 1; }
  }
  if (geo) {
    if (geo.proxy === true) score -= 15;
    if (geo.hosting === true) score -= 5;
    if (geo.mobile === true) score += 5;
  }
  if (score < 0) score = 0;
  if (score > 100) score = 100;
  let risk = 'unknown';
  if (score >= 80) risk = 'low';
  else if (score >= 50) risk = 'medium';
  else risk = 'high';
  return { score, risk, listedCount, checkedCount };
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store', // per-user/per-IP, don't cache
    },
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  let ip = (url.searchParams.get('ip') || '').trim();
  if (!ip) {
    ip = request.headers.get('CF-Connecting-IP') || '';
  }
  if (!isValidIPv4(ip)) {
    return json({ error: 'invalid_ip', message: 'Provide a valid IPv4 address (e.g. 1.2.3.4) or omit to check your own.' }, 400);
  }
  const start = Date.now();
  const [dnsbl, geo] = await Promise.all([queryAllDnsbls(ip), queryGeo(ip)]);
  const { score, risk, listedCount, checkedCount } = computeScore(dnsbl, geo);
  return json({
    ip,
    fetched_ms: Date.now() - start,
    score,
    risk,
    dnsbl: { checked: checkedCount, listed: listedCount, total: DNSBLS.length, results: dnsbl },
    geo: geo || null,
  });
}
