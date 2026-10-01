// =====================================================================
// sitetrace-api — Email Deliverability (SPF / DKIM / DMARC / MX / BIMI)
//
// Endpoint: GET /api/email?domain=example.com
//
// Same logic as sitetrace's /api/email-deliverability Worker, re-
// implemented here for self-containment. See the comments there for
// the scoring rationale.
//
// Auth: shared middleware.
// =====================================================================

const DOH = 'https://1.1.1.1/dns-query';
const TIMEOUT_MS = 6000;

const DKIM_SELECTORS = [
  'default', 'google', 'k1', 's1', 's2', 'selector1', 'selector2',
  'mail', 'dkim', 'mx', 'cm', 'mandrill', 'mailjet', 'sendgrid',
  'mailgun', 'postmark', 'smtp', 'email', 'sig1', 'sig2',
];

function isValidDomain(input) {
  if (!input || typeof input !== 'string') return false;
  let s = input.trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  if (s.length > 253) return false;
  return /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(s);
}

async function doh(name, type) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(
      `${DOH}?name=${encodeURIComponent(name)}&type=${type}`,
      { headers: { 'Accept': 'application/dns-json' }, signal: ctrl.signal }
    );
    clearTimeout(t);
    if (!resp.ok) return { status: 'http_' + resp.status, answers: [] };
    const data = await resp.json();
    if (data.Status === 3) return { status: 'nxdomain', answers: [] };
    if (data.Status !== 0) return { status: 'dns_status_' + data.Status, answers: [] };
    return { status: 'ok', answers: (data.Answer || []).map(a => ({ name: a.name, type: a.type, TTL: a.TTL, data: a.data })) };
  } catch (e) {
    return { status: e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || 'error', answers: [] };
  }
}

function parseSpf(records) {
  const txts = records.filter(r => typeof r.data === 'string' && r.data.replace(/^"|"$/g, '').toLowerCase().indexOf('v=spf1') === 0);
  if (txts.length === 0) return { present: false };
  const raw = txts[0].data.replace(/^"|"$/g, '');
  const mechanisms = raw.split(/\s+/).slice(1);
  const all = mechanisms.filter(m => m === '-all' || m === '~all' || m === '?all' || m === '+all');
  const qualifier = all.length > 0 ? all[0] : null;
  const hasTooManyLookups = mechanisms.filter(m => /^(include|a|mx|ptr|exists|redirect):/i.test(m)).length > 10;
  return { present: true, record: raw, qualifier, mechanismCount: mechanisms.length, tooManyLookups: hasTooManyLookups };
}

function parseDmarc(records) {
  const txts = records.filter(r => typeof r.data === 'string' && r.data.replace(/^"|"$/g, '').toLowerCase().indexOf('v=dmarc1') === 0);
  if (txts.length === 0) return { present: false };
  const raw = txts[0].data.replace(/^"|"$/g, '');
  const tags = {};
  raw.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const k = part.slice(0, idx).trim().toLowerCase();
    const v = part.slice(idx + 1).trim();
    if (k) tags[k] = v;
  });
  return {
    present: true,
    record: raw,
    policy: (tags.p || 'none').toLowerCase(),
    subdomainPolicy: (tags.sp || tags.p || 'none').toLowerCase(),
    percentage: tags.pct ? parseInt(tags.pct, 10) : 100,
    reportingAggregate: tags.rua || null,
    reportingForensic: tags.ruf || null,
    alignmentDkim: (tags.adkim || 'r').toLowerCase(),
    alignmentSpf: (tags.aspf || 'r').toLowerCase(),
  };
}

function parseDkim(records) {
  const txts = records.filter(r => typeof r.data === 'string' && r.data.replace(/^"|"$/g, '').toLowerCase().indexOf('v=dkim1') === 0);
  if (txts.length === 0) return { present: false };
  const raw = txts[0].data.replace(/^"|"$/g, '');
  const tags = {};
  raw.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const k = part.slice(0, idx).trim().toLowerCase();
    const v = part.slice(idx + 1).trim();
    if (k) tags[k] = v;
  });
  return { present: true, record: raw, keyType: tags.k || 'rsa', domain: tags.d || null };
}

function parseBimi(records) {
  const txts = records.filter(r => typeof r.data === 'string' && r.data.replace(/^"|"$/g, '').toLowerCase().indexOf('v=bimi1') === 0);
  if (txts.length === 0) return { present: false };
  return { present: true, record: txts[0].data.replace(/^"|"$/g, '') };
}

function parseMx(records) {
  if (records.length === 0) return { present: false, hosts: [] };
  return {
    present: true,
    hosts: records.map(r => {
      const parts = String(r.data || '').split(/\s+/);
      return { preference: parseInt(parts[0], 10) || 0, host: parts.slice(1).join(' ') };
    }).sort((a, b) => a.preference - b.preference),
  };
}

function computeScore(spf, dkim, dmarc, mx) {
  let score = 100;
  const issues = [];
  const checks = [];
  if (!spf.present) {
    score -= 30;
    issues.push('No SPF record found at the apex.');
    checks.push({ id: 'spf', pass: false, value: null, message: 'No SPF record found at the apex.' });
  } else {
    if (!spf.qualifier || spf.qualifier !== '-all') {
      score -= 15;
      issues.push('SPF exists but does not end with -all.');
      checks.push({ id: 'spf_strict', pass: false, value: spf.qualifier, message: 'SPF ends with "' + (spf.qualifier || 'no qualifier') + '" instead of "-all".' });
    } else {
      checks.push({ id: 'spf_strict', pass: true, value: '-all', message: 'SPF ends with -all (strict).' });
    }
    if (spf.tooManyLookups) {
      score -= 10;
      issues.push('SPF uses more than 10 DNS lookups (RFC violation).');
      checks.push({ id: 'spf_lookups', pass: false, value: spf.mechanismCount, message: 'SPF triggers ' + spf.mechanismCount + ' DNS lookups (RFC max is 10).' });
    } else {
      checks.push({ id: 'spf_lookups', pass: true, value: spf.mechanismCount, message: 'SPF uses ' + spf.mechanismCount + ' mechanisms (within RFC limit).' });
    }
    checks.push({ id: 'spf', pass: true, value: 'v=spf1', message: 'SPF record found.' });
  }
  if (!dkim.present) {
    score -= 25;
    issues.push('No DKIM record found on any common selector.');
    checks.push({ id: 'dkim', pass: false, value: null, message: 'No DKIM record found on ' + DKIM_SELECTORS.length + ' common selectors.' });
  } else {
    checks.push({ id: 'dkim', pass: true, value: dkim.domain, message: 'DKIM found at ' + dkim.selector + '._domainkey.' + dkim.domain + '.' });
  }
  if (!dmarc.present) {
    score -= 25;
    issues.push('No DMARC record at _dmarc.');
    checks.push({ id: 'dmarc', pass: false, value: null, message: 'No DMARC record at _dmarc.' });
  } else {
    if (dmarc.policy === 'none') {
      score -= 15;
      issues.push('DMARC policy is "none" — receivers are not told to reject forged mail.');
      checks.push({ id: 'dmarc_policy', pass: false, value: 'none', message: 'DMARC policy is "none" (monitoring only).' });
    } else if (dmarc.policy === 'quarantine') {
      checks.push({ id: 'dmarc_policy', pass: true, value: 'quarantine', message: 'DMARC policy is "quarantine".' });
    } else if (dmarc.policy === 'reject') {
      checks.push({ id: 'dmarc_policy', pass: true, value: 'reject', message: 'DMARC policy is "reject" (strictest).' });
    }
    checks.push({ id: 'dmarc', pass: true, value: 'v=DMARC1', message: 'DMARC record found.' });
  }
  if (!mx.present) {
    score -= 15;
    issues.push('No MX records — this domain cannot receive email.');
    checks.push({ id: 'mx', pass: false, value: null, message: 'No MX records found.' });
  } else {
    checks.push({ id: 'mx', pass: true, value: mx.hosts.length + ' host(s)', message: 'MX records found (' + mx.hosts.length + ').' });
  }
  if (score < 0) score = 0;
  if (score > 100) score = 100;
  let risk = 'unknown';
  if (score >= 80) risk = 'low';
  else if (score >= 50) risk = 'medium';
  else risk = 'high';
  return { score, risk, issues, checks };
}

async function probeDkim(domain) {
  // CF Workers allows only 6 simultaneous subrequests per invocation. Doing
  // Promise.all over 20 selectors + 3 other DoH calls = 23 in flight would
  // cause the runtime to either queue or crash. Walk in batches of 5 and
  // short-circuit as soon as we find a valid DKIM record.
  const BATCH = 5;
  for (let i = 0; i < DKIM_SELECTORS.length; i += BATCH) {
    const slice = DKIM_SELECTORS.slice(i, i + BATCH);
    const results = await Promise.all(slice.map(async sel => {
      const r = await doh(sel + '._domainkey.' + domain, 'TXT');
      return { selector: sel, records: r.answers };
    }));
    for (const r of results) {
      if (r.records.length > 0) {
        const parsed = parseDkim(r.records);
        if (parsed.present) return { ...parsed, selector: r.selector };
      }
    }
  }
  return { present: false, probedSelectors: DKIM_SELECTORS, probedCount: DKIM_SELECTORS.length };
}

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
  const { request } = context;
  const url = new URL(request.url);
  let domain = (url.searchParams.get('domain') || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  if (!isValidDomain(domain)) {
    return json({ error: 'invalid_domain', message: 'Provide a valid domain (e.g. example.com).' }, 400);
  }
  const start = Date.now();
  try {
    const [spfRec, dmarcRec, mxRec] = await Promise.all([
      doh(domain, 'TXT'),
      doh('_dmarc.' + domain, 'TXT'),
      doh(domain, 'MX'),
    ]);
    const [dkim, bimi] = await Promise.all([
      probeDkim(domain),
      doh('default._bimi.' + domain, 'TXT').then(parseBimi).catch(() => ({ present: false })),
    ]);
    const spf   = parseSpf(spfRec.answers);
    const dmarc = parseDmarc(dmarcRec.answers);
    const mx    = parseMx(mxRec.answers);
    const { score, risk, issues, checks } = computeScore(spf, dkim, dmarc, mx);
    return json({
      domain,
      fetched_ms: Date.now() - start,
      score,
      risk,
      issues,
      checks,
      records: {
        spf:   { ...spf,   raw: spfRec.answers.map(a => a.data) },
        dkim,
        dmarc: { ...dmarc, raw: dmarcRec.answers.map(a => a.data) },
        mx,
        bimi,
      },
    });
  } catch (e) {
    return json({
      error: 'internal_error',
      message: (e && e.message) || String(e),
      hint: 'DoH upstream or DNS resolution failed',
    }, 500);
  }
}
