# Deployment checklist — sitetrace API

This is the one-time setup to get `api.sitetrace.it.com` live with all 5 APIs.

## Prerequisites

You need:
- A Cloudflare account (you have one — `appenzeller.digitalstore@gmail.com`)
- A GitHub account (you have one — `appenzellerdigitalstore-stack`)
- Namecheap access for the DNS
- ~30 minutes

## Step 1: Create the GitHub repo

The existing `appenzellerdigitalstore-stack/sitetrace-api` repo is a
different project (Node uptime monitor on Render). The new code lives at
`appenzellerdigitalstore-stack/sitetrace-cloud`.

```bash
cd C:/Users/edy_a/.minimax-agent/projects/sitetrace-api
gh repo create sitetrace-cloud --public --source=. --remote=origin --push \
  --description "Sitetrace API — utility APIs for developers (screenshots, IP reputation, email, headers, preview, SSL/CT)"
```

The CF Pages project is still named `sitetrace-api` (the public URL is
`api.sitetrace.it.com`, the project label is internal).

## Step 2: Add the GitHub secrets

In the GitHub repo → Settings → Secrets and variables → Actions → New repository secret, add:

- `CLOUDFLARE_API_TOKEN` — same one you use for sitetrace, or a new one with `Account: Cloudflare Pages: Edit` scope.
- `CLOUDFLARE_ACCOUNT_ID` — the 32-char account id from the CF dashboard.

## Step 3: Create the Cloudflare Pages project

Option A — via the dashboard:
- Workers & Pages → Create application → Pages → Connect to Git
- Pick the `sitetrace-api` repo
- Build command: *(leave empty)*
- Build output directory: `/`
- Click Save and Deploy

Option B — via the API (we can do this with `wrangler`):
```bash
npx wrangler pages project create sitetrace-api --production-branch=main
```

## Step 4: Add the DNS at Namecheap

In Namecheap → Domain List → sitetrace.it.com → Manage → Advanced DNS, add a CNAME record:

- Type: `CNAME`
- Host: `api`
- Value: `sitetrace-api.pages.dev`
- TTL: Automatic

## Step 5: Add the custom domain in Cloudflare

In Cloudflare → Workers & Pages → sitetrace-api → Custom domains → Set up a custom domain:
- `api.sitetrace.it.com`

Cloudflare will verify the DNS and issue the cert. This takes 1-5 minutes.

## Step 6: Enable Browser Rendering

Browser Rendering is a Workers feature. To enable:

- Workers & Pages → Settings (account-level, not project-level) → Browser Rendering → Enable

This requires the Workers Paid plan ($5/mo). It includes 500 minutes of browser time, which is ~10,000-100,000 screenshots depending on size.

After enabling, add the binding to `wrangler.toml`:
```toml
[[browser]]
binding = "BROWSER"
```

## Step 7: Create the D1 database

```bash
npx wrangler d1 create sitetrace-api
```

Copy the `database_id` from the output into `wrangler.toml`:
```toml
[[d1_databases]]
binding = "DB"
database_name = "sitetrace-api"
database_id = "PASTE_HERE"
```

The deploy workflow runs `d1 execute` automatically on every push, so migrations are applied.

## Step 8: Create the KV namespace (optional but recommended)

```bash
npx wrangler kv namespace create RATELIMIT
```

Paste the `id` into `wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "RATELIMIT"
id = "PASTE_HERE"
```

KV is used for the SSL/CT cache. Without it, every cert query hits crt.sh directly.

## Step 9: Set up Paddle

1. Create a Paddle account at paddle.com (use your Honduras address; they pay out to PayPal).
2. In Paddle dashboard → Catalog → Products, create one product with three prices:
   - Hobby: $9/month
   - Pro: $49/month
   - Volume: $199/month
3. Copy each price's `id` (looks like `pri_01hxxxxxx`).
4. In Paddle dashboard → Developer tools → Authentication, create an API key (for server-side checkout sessions, if you decide to use them).
5. In Paddle dashboard → Developer tools → Notifications, set up a webhook:
   - URL: `https://api.sitetrace.it.com/api/paddle-webhook`
   - Events: `subscription.created`, `subscription.updated`, `subscription.canceled`, `subscription.expired`
6. Copy the webhook secret and set it as a Cloudflare Pages environment variable (next step).

## Step 10: Set Cloudflare Pages environment variables

In Cloudflare → Workers & Pages → sitetrace-api → Settings → Environment variables, add:

- `PADDLE_WEBHOOK_SECRET` — from step 9
- `PADDLE_PRICE_HOBBY` — `pri_xxx` for the $9 plan
- `PADDLE_PRICE_PRO` — `pri_xxx` for the $49 plan
- `PADDLE_PRICE_VOLUME` — `pri_xxx` for the $199 plan
- `PADDLE_CLIENT_TOKEN` — the Paddle.js client-side token (live one, not test)

In `public/pricing.html`, the `window.PADDLE_PRICE_*` variables need to be set at build time. Edit the file's `checkout()` function to use the env values, or hard-code them after creating the Paddle prices. (A follow-up patch can do this with `wrangler` env substitution.)

## Step 11: First deploy

```bash
git add .
git commit -m "Add database_id, KV id, browser binding, env-driven price IDs"
git push origin main
```

Watch the Actions tab. You should see:
- "Apply D1 migrations" — runs the schema
- "Deploy to Cloudflare Pages" — uploads the site

If both pass, visit `https://api.sitetrace.it.com/` — you should see the landing page.

## Step 12: Smoke tests

```bash
# Screenshot (no auth, should work)
curl -I "https://api.sitetrace.it.com/api/shot?url=https://example.com"

# IP reputation (no auth, should work)
curl "https://api.sitetrace.it.com/api/ip?ip=8.8.8.8" | jq

# Email (no auth)
curl "https://api.sitetrace.it.com/api/email?domain=github.com" | jq

# Signup (creates a free key)
curl -X POST -H "Content-Type: application/json" \
  -d '{"email":"you@example.com"}' \
  https://api.sitetrace.it.com/api/signup | jq

# With the key from above
curl "https://api.sitetrace.it.com/api/account?key=stk_..." | jq
```

## Step 13: Submit to Google Search Console

1. GSC → Add property → URL prefix → `https://api.sitetrace.it.com`
2. Verify via DNS TXT record (add it at Namecheap)
3. Sitemaps → submit `https://api.sitetrace.it.com/sitemap.xml`

## Step 14: Link from sitetrace homepage

Add a footer link from `sitetrace.it.com` → `api.sitetrace.it.com` on the existing sitetrace site. This is a free backlink from a same-domain property.

That's the whole setup. After this, every `git push` to main auto-deploys.
