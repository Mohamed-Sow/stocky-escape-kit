# Render Deployment

This app is prepared for a low-maintenance Render production setup:

- Web service: Docker, `starter` plan.
- Web compute: `512 MB` RAM and `0.5` CPU. Upload and report limits in
  `app/lib/entitlements.server.ts` must remain within that in-memory processing
  envelope unless the service or processing architecture is upgraded.
- Database: Render Postgres, `basic-1gb` plan.
- Database storage: explicit `15 GB` flexible-plan disk (independent of the
  `basic-1gb` compute name).
- Region: `ohio` for both services.
- Health check: `/healthz`.
- Production URL: `https://stocky-escape-kit.onrender.com`.
- Render service ID: `srv-d978pp0js32c73bv11ag`.
- Render Postgres ID: `dpg-d978etfaqgkc73d4e59g-a`.
- Current Blueprint estimate: about `$30.50/month` before bandwidth or future
  upgrades.

## Existing Render deployment

The production web service and Postgres database already exist in Render. The
web service is linked to `Mohamed-Sow/stocky-escape-kit` on `main`. Do not open
the New Blueprint flow or create a second pair of services for routine updates;
pushes to `main` trigger the existing web service's auto-deploy.

Use the existing service's **Environment** page to rotate credentials or add
new keys, and use **Settings** to verify the repository, branch, Dockerfile,
plan, and health-check path. A repository push is therefore a production deploy
action and should be intentional.

The database must not retain Render's default `0.0.0.0/0` inbound rule. The web
service uses the database's internal URL, so production can set the database
`ipAllowList` to an empty list and block every external connection. If a
temporary operator connection is required for a smoke test, allow only that
operator's current `/32` address and remove it afterward. A database password is
not a substitute for restricting the public network path.

## Initial provisioning reference

These steps are retained only for disaster recovery or a genuinely new Render
workspace:

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
   - `SHOPIFY_APP_HANDLE`: `stocky-escape-kit-1`.
   - `SHOPIFY_PARTNER_ORG_ID`: the Partner organization ID that owns the app.
   - `SHOPIFY_PARTNER_API_TOKEN`: a Partner API client token with Manage apps permission.
   - `SHOPIFY_PARTNER_APP_ID`: the app GID used by Partner API `activeSubscription`.
   - `SHOPIFY_SMOKE_TOKEN`: a new high-entropy operator secret for the protected hosted smoke endpoint.
   - `SUPPORT_EMAIL`: the monitored merchant and privacy support address shown on the public support and privacy pages.
5. Keep `DATABASE_URL` sourced from the Blueprint database reference. Do not paste a local database URL.

`basic-1gb` describes the database compute/RAM class, not its disk size. The
Blueprint pins the current Basic default of `15 GB` so raw CSV entitlements do
not silently depend on a dashboard default. Render bills flexible-plan storage
separately.

The database disk does not make large request bodies safe. This app currently
parses multipart uploads and generates CSV/ZIP reports in the web process, so
plan limits pair stored-data allowances with much smaller per-request byte and
row ceilings. A synthetic 35 MB / 100,000-row parser check exceeded 1 GB RSS,
so that workload cannot be advertised on the 512 MB service. Do not raise the
current 10 MB per-file or 20 MB per-run maximum merely because unused Postgres
disk is available. The retained-source maximum is 500 MB because base64 raw
files, parsed JSON, indexes, and catalog snapshots all consume more disk than
the original CSV byte count.

## Shopify production URL setup

After the first Render deploy succeeds:

1. Copy the Render web service URL.
2. Set `SHOPIFY_APP_URL` in Render to that exact HTTPS origin.
3. Update the Shopify app URL and redirect URL to:
   - App URL: the Render HTTPS origin.
   - Redirect URL: `<Render HTTPS origin>/auth/callback`.
4. Deploy the Shopify app configuration with `npm run deploy` after confirming `shopify.app.toml` points at the production URL.

The Docker startup path runs `prisma migrate deploy`, so deployments that
include raw CSV preservation must apply the `UploadedFile.rawContentBase64` and
`UploadedFile.rawContentByteLength` migration before uploads are accepted.

## Validation

Run these checks before treating the deployment as submission-ready:

```sh
npm run risk:audit
SHOPIFY_TEST_SHOP=stocky-escape-kit-partner-dev.myshopify.com npm run smoke:shopify
```

Before the live smoke, configure Shopify App Pricing in the Partner Dashboard:

- Public monthly billing plans: `Stocky Basic` (`$99/mo`), `Stocky Pro` (`$199/mo`), and `Stocky Plus` (`$299/mo`); public listing display names can use `Stocky Escape Kit Basic`, `Stocky Escape Kit Pro`, and `Stocky Escape Kit Plus`.
- Private `$0` review/dev plan: Shopify's reserved `shopify-test` plan, rendered to merchants as `Stocky Review Test`; the Partner API description `Shopify Test` is diagnostic evidence only.
- Welcome links should return reviewers to `/app`.

For the live smoke, select the private review/dev plan in the dev store, then
set `DATABASE_URL` to the Render database connection string if running it from
your machine against the production install. The smoke test must prove:

- OAuth created or reused a Prisma offline session.
- Billing is active according to Partner API `activeSubscription` for this app and shop.
- Granted scopes are exactly read-only: `read_products`, `read_inventory`, `read_locations`.
- Products and locations GraphQL queries succeed.

If local database access is blocked by the Render Postgres IP allow list, use
the secret `SHOPIFY_SMOKE_TOKEN` configured in Render and run the smoke script
against the protected hosted smoke endpoint instead:

```sh
SHOPIFY_TEST_SHOP=stocky-escape-kit-partner-dev.myshopify.com \
SHOPIFY_SMOKE_ENDPOINT_URL=https://stocky-escape-kit.onrender.com/ops/shopify-smoke \
SHOPIFY_SMOKE_TOKEN=$SHOPIFY_SMOKE_TOKEN \
npm run smoke:shopify
```

## Submission readiness notes

- Keep `SHOPIFY_BILLING_TEST=false` for production merchant installs.
- Confirm the database Networking panel does not show `0.0.0.0/0`; an empty
  datastore allowlist blocks external connections while same-region services
  keep using Render's private network.
- Use the private `$0` review/dev plan only in development or review-proof contexts where Shopify permits it.
- Do not use a temporary Cloudflare tunnel URL in production app settings.
- Do not claim the app imports historical Stocky purchase orders into Shopify.
