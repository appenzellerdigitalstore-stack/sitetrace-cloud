// scripts/build-roadmap.mjs
//
// Reads tracker-roadmap.csv from this repo's root and renders the
// "Now / Next / Future / Recently shipped" sections of /roadmap.html.
//
// Usage:  node scripts/build-roadmap.mjs
//
// Output: writes ./roadmap.html (overwrites). Commit the result.
// Idempotent — running it again produces a byte-identical file (modulo
// whitespace) when the CSV is unchanged.
//
// Sections come from the Section column:
//   - "Roadmap" items with Priority URGENT -> "Now"
//   - "Roadmap" items with Priority NEXT   -> "Next"
//   - "Roadmap" items with Priority FUTURE -> "Future"
//   - "Done" items                              -> "Recently shipped" (last 12)
//
// Anti-feature: we deliberately skip Decision / Bug / Risk / Number
// rows from the public roadmap. Internal state is noisy and not what
// paying customers want to read. The full CSV is in the repo at
// tracker-roadmap.csv for anyone who cares.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const CSV_PATH = resolve(ROOT, 'tracker-roadmap.csv');
const HTML_PATH = resolve(ROOT, 'roadmap.html');

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  const rows = [];
  for (const line of lines) {
    const fields = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && (i === 0 || line[i-1] !== '\\')) {
        inQuotes = !inQuotes;
        continue;
      }
      if (ch === ',' && !inQuotes) {
        fields.push(cur);
        cur = '';
        continue;
      }
      cur += ch;
    }
    fields.push(cur);
    rows.push(fields);
  }
  return rows;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const csvText = readFileSync(CSV_PATH, 'utf8');
const allRows = parseCsv(csvText);
const header = allRows[0];
const COL = Object.fromEntries(header.map((h, i) => [h, i]));
const dataRows = allRows.slice(1).map(r => ({
  date: r[COL.Date] || '',
  section: r[COL.Section] || '',
  item: r[COL.Item] || '',
  status: r[COL.Status] || '',
  priority: r[COL.Priority] || '',
  owner: r[COL.Owner] || '',
  details: r[COL.Details] || '',
}));

// Bucket by visibility. Only Roadmap rows with Status=TODO/PLANNING/BLOCKED
// show in the Now/Next/Future sections — anything marked DONE in the
// Roadmap section is a stale carryover and gets filtered out (the right
// place for shipped items is the Done section, which is sorted by date).
// Rows marked DELETED/DUP_* are tracker-cleanup markers that should not
// show up at all.
const isOpen = r => /^(TODO|PLANNING|BLOCKED|OPEN)$/i.test(r.status || '');
const isLive = r => !/^(DELETED|DUP_)/i.test(r.status || '');
const now = dataRows.filter(r => r.section === 'Roadmap' && r.priority === 'URGENT' && isOpen(r) && isLive(r));
const next = dataRows.filter(r => r.section === 'Roadmap' && r.priority === 'NEXT' && isOpen(r) && isLive(r));
const future = dataRows.filter(r => r.section === 'Roadmap' && r.priority === 'FUTURE' && isOpen(r) && isLive(r));
const done = dataRows.filter(r => r.section === 'Done' && isLive(r))
  .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
  .slice(0, 12);

function renderItem(r) {
  const dateStr = r.date ? `<span class="muted small">${esc(r.date)}</span> · ` : '';
  const owner = r.owner ? `<span class="muted small">${esc(r.owner)}</span>` : '';
  return `
    <li class="roadmap-item">
      <div class="roadmap-title">${esc(r.item)}</div>
      <div class="roadmap-meta">${dateStr}${owner}</div>
      ${r.details ? `<div class="roadmap-details">${esc(r.details)}</div>` : ''}
    </li>`;
}

function renderSection(title, items, emptyMsg) {
  if (items.length === 0) {
    return `
    <section class="roadmap-section">
      <h2>${esc(title)}</h2>
      <p class="muted">${esc(emptyMsg)}</p>
    </section>`;
  }
  return `
    <section class="roadmap-section">
      <h2>${esc(title)} <span class="count">${items.length}</span></h2>
      <ul class="roadmap-list">${items.map(renderItem).join('')}</ul>
    </section>`;
}

const generatedAt = new Date().toISOString().slice(0, 10);
const totalCounts = `${now.length} now · ${next.length} next · ${future.length} future · ${done.length} shipped`;

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Roadmap — sitetrace API</title>
  <meta name="description" content="What we're shipping now, next, and beyond on sitetrace API. Updated from the project tracker." />
  <meta name="robots" content="index, follow" />
  <link rel="canonical" href="https://api.sitetrace.it.com/roadmap/" />
  <link rel="stylesheet" href="/styles.css" />
  <style>
    .roadmap-section { margin: 32px 0; }
    .roadmap-section h2 { display: flex; align-items: baseline; gap: 12px; }
    .roadmap-section h2 .count {
      font-family: var(--mono); font-size: 13px;
      background: var(--bg-elev); padding: 2px 8px; border-radius: 4px;
      color: var(--muted);
    }
    .roadmap-list { list-style: none; padding: 0; margin: 0; }
    .roadmap-item {
      border-top: 1px solid var(--border, #1f2937);
      padding: 16px 0;
    }
    .roadmap-item:first-child { border-top: none; padding-top: 8px; }
    .roadmap-title { font-weight: 600; font-size: 16px; }
    .roadmap-meta { font-size: 13px; margin-top: 2px; }
    .roadmap-details { font-size: 14px; margin-top: 6px; color: var(--muted); line-height: 1.5; }
    .summary-bar {
      display: flex; gap: 12px; flex-wrap: wrap;
      font-family: var(--mono); font-size: 13px;
      padding: 12px 16px; background: var(--bg-elev);
      border-radius: 6px; border: 1px solid var(--border, #1f2937);
    }
    .summary-bar span { color: var(--muted); }
    .updated-at { font-family: var(--mono); font-size: 12px; color: var(--muted); margin-top: 32px; }
  </style>
</head>
<body>
  <header class="site-header">
    <div class="container">
      <a href="/" class="brand"><span class="dot"></span>sitetrace API</a>
      <nav class="nav">
        <a href="/shot/">Screenshot</a>
        <a href="/ip/">IP</a>
        <a href="/email/">Email</a>
        <a href="/preview/">Preview</a>
        <a href="/certs/">SSL</a>
        <a href="/docs/">Docs</a>
        <a href="/pricing/">Pricing</a>
        <a href="/status/">Status</a>
      </nav>
    </div>
  </header>

  <div class="container">
    <section class="hero" style="padding-top: 60px; border-top: none;">
      <h1>Roadmap</h1>
      <p class="lede">What we're shipping on sitetrace API, in priority order. Same data as our internal tracker — we keep no secrets from you.</p>
      <div class="summary-bar">
        <span>${totalCounts}</span>
      </div>
    </section>

    ${renderSection('Now', now, 'Nothing urgent right now. We ship calmly.')}
    ${renderSection('Next', next, 'Nothing on deck for the next sprint.')}
    ${renderSection('Future', future, 'Longer-term ideas we want to get to when revenue funds them.')}
    ${renderSection('Recently shipped', done, 'No shipped items yet.')}
  </div>

  <footer class="site-footer">
    <div class="container">
      <div>© sitetrace API</div>
      <div class="links">
        <a href="/">Home</a>
        <a href="/docs/">Docs</a>
        <a href="/changelog/">Changelog</a>
        <a href="/status/">Status</a>
      </div>
    </div>
  </footer>

  <p class="updated-at" style="text-align: center;">Generated ${generatedAt} · <a href="https://github.com/appenzellerdigitalstore-stack/sitetrace-cloud/blob/main/tracker-roadmap.csv">source: tracker-roadmap.csv</a></p>
</body>
</html>
`;

writeFileSync(HTML_PATH, html, 'utf8');
console.log(`Wrote ${HTML_PATH} (${html.length} bytes)`);
console.log(`Buckets: ${now.length} URGENT, ${next.length} NEXT, ${future.length} FUTURE, ${done.length} Done (recent)`);