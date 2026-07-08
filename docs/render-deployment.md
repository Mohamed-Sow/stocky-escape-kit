# Render Deployment

This app is prepared for a low-maintenance Render production setup:

- Web service: Docker, `starter` plan.
- Database: Render Postgres, `basic-1gb` plan.
- Region: `ohio` for both services.
- Health check: `/healthz`.
- Production URL: `https://stocky-escape-kit.onrender.com`.
- Render service ID: `srv-d978pp0js32c73bv11ag`.
- Render Postgres ID: `dpg-d978etfaqgkc73d4e59g-a`.
- Expected cost target: about `$26/month` before bandwidth or future upgrades.

## Create the Render services

1. Add a payment method to the Render workspace. The `starter` web service and
   `basic-1gb` Postgres database are paid resources; without billing enabled,
   Render CLI validation returns `need_payment_info` for both resources.
2. Push this repo to the Git provider connected to Render.
   - Current deploy source: `https://github.com/Mohamed-Sow/stocky-escape-kit`.
   - The repo is public because Render's private GitHub provider connection did
     not persist for this workspace. No production secrets are committed; keep
     secrets in Render environment variables only.
3. In Render, create a new Blueprint from the repo root. Render should detect `render.yaml`.
4. When prompted for secret values, provide:
   - `SHOPIFY_API_KEY`: the app client ID from Shopify.
   - `SHOPIFY_API_SECRET`: the app client secret from Shopify.
   - `SHOPIFY_APP_URL`: the final Render HTTPS URL, for example `https://stocky-escape-kit.onrender.com`.
5. Keep `DATABASE_URL` sourced from the Blueprint database reference. Do not paste a local database URL.

## Shopify production URL setup

After the first Render deploy succeeds:

1. Copy the Render web service URL.
2. Set `SHOPIFY_APP_URL` in Render to that exact HTTPS origin.
3. Update the Shopify app URL and redirect URL to:
   - App URL: the Render HTTPS origin.
   - Redirect URL: `<Render HTTPS origin>/api/auth`.
4. Deploy the Shopify app configuration with `npm run deploy` after confirming `shopify.app.toml` points at the production URL.

## Validation

Run these checks before treating the deployment as submission-ready:

```sh
npm run risk:audit
SHOPIFY_TEST_SHOP=stocky-escape-kit-partner-dev.myshopify.com npm run smoke:shopify
```

For the live smoke, set `DATABASE_URL` to the Render database connection string if running it from your machine against the production install. The smoke test must prove:

- OAuth created or reused a Prisma offline session.
- Billing is active for a Stocky Escape Kit plan.
- Granted scopes are exactly read-only: `read_products`, `read_inventory`, `read_locations`.
- Products and locations GraphQL queries succeed.

If local database access is blocked by the Render Postgres IP allow list, set a
secret `SHOPIFY_SMOKE_TOKEN` in Render and call the protected hosted smoke
endpoint instead:

```sh
curl -H "Authorization: Bearer $SHOPIFY_SMOKE_TOKEN" \
  "https://stocky-escape-kit.onrender.com/ops/shopify-smoke?shop=stocky-escape-kit-partner-dev.myshopify.com"
```

## Submission readiness notes

- Keep `SHOPIFY_BILLING_TEST=false` for production merchant installs.
- Use Shopify test billing only in development or review-proof contexts where Shopify permits it.
- Do not use a temporary Cloudflare tunnel URL in production app settings.
- Do not claim the app imports historical Stocky purchase orders into Shopify.
