# sitetrace-cloud (Cloudflare Pages: sitetrace-api)

Utility APIs for developers. Hosted at **https://api.sitetrace.it.com**.

GitHub: `appenzellerdigitalstore-stack/sitetrace-cloud`
CF Pages project: `sitetrace-api` (note: GitHub repo and CF Pages project
have different names — the existing `sitetrace-api` repo is a different
project, so this new code lives in `sitetrace-cloud` on GitHub)

| API | Endpoint | Description |
|---|---|---|
| Screenshot | `GET /api/shot?url=...` | URL → PNG, rendered with headless Chrome |
| IP Reputation | `GET /api/ip?ip=...` | 7 DNSBLs + ASN + geo + risk score |
| Email Deliverability | `GET /api/email?domain=...` | SPF / DKIM / DMARC / MX / BIMI |
| HTTP Headers | `GET /api/headers?url=...` | Security headers + score |
| URL Preview | `GET /api/preview?url=...` | Open Graph + meta + favicon |
| SSL/CT Lookup | `GET /api/certs?domain=...` | Certificate Transparency log query |

All endpoints return JSON (except `/api/shot`, which returns PNG).
Free tier: 100 calls/day, no signup, IP rate-limited. Paid tiers: see `pricing.html`.

## Local dev

```bash
npm install
wrangler d1 create sitetrace-api          # creates D1, paste id into wrangler.toml
wrangler kv namespace create RATELIMIT    # creates KV, paste id into wrangler.toml
npm run db:migrate:local
npm run dev
```

## Deploy

Push to `main` — GitHub Actions runs the D1 migration and deploys to Cloudflare Pages.

## Project structure

```
public/                — static docs site (HTML, CSS, JS)
  index.html           — landing page
  shot.html, ip.html, …  — one landing page per API
  pricing.html         — pricing tiers + Paddle checkout
  signup.html, login.html, dashboard.html  — customer flow
  status.html          — service health
  changelog.html       — product updates
  vs-*.html            — SEO comparison pages
  best-*.html          — SEO listicles
  how-to-*.html        — SEO how-tos
  sitemap.xml, robots.txt, ads.txt
functions/
  _middleware.js       — auth + rate-limit for all /api/* requests
  api/
    shot.js            — screenshot (Browser Rendering)
    ip.js              — IP reputation
    email.js           — email deliverability
    headers.js         — HTTP headers
    preview.js         — URL preview / Open Graph
    certs.js           — SSL certificate transparency
    signup.js          — email signup → free API key
    login.js           — email login (magic link)
    account.js         — GET /api/account (key info, usage, quota)
    paddle-webhook.js  — Paddle subscription events
migrations/
  0001_init.sql        — D1 schema
.github/workflows/
  deploy.yml           — auto-deploy on push to main
```
