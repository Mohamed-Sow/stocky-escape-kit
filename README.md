# Stocky Escape Kit

## Product Summary

Stocky Escape Kit is a Shopify public app for merchants migrating away from Stocky before the August 31, 2026 shutdown. The app preserves original Stocky CSV uploads plus parsed rows and metadata, audits migration gaps, reconstructs supplier hints, and produces Shopify-ready cleanup reports.

This app should not become full inventory management software in v1.

## Core Merchant Promise

"Back up your Stocky CSV exports, find what will not migrate cleanly, and get a clear action list before Stocky shuts down."

## MVP Outcomes

- Merchant uploads Stocky CSV exports.
- App stores raw uploaded CSV bytes, file hashes, normalized rows, unknown columns, and import metadata.
- App matches Stocky rows to Shopify SKUs, products, variants, inventory items, and locations.
- App reports missing SKUs, duplicate SKUs, missing cost, missing barcode, missing vendor, unmatched locations, parse errors, and supplier reconstruction candidates.
- Merchant exports clean archive and migration reports.

## Implemented App Flow

- OAuth install/linking uses the official Shopify React Router app package and Prisma session storage.
- Billing uses Shopify App Pricing subscriptions. Public listing display names are `Stocky Escape Kit Basic` at `$99/mo`, `Stocky Escape Kit Pro` at `$199/mo`, and `Stocky Escape Kit Plus` at `$299/mo`; Shopify's immutable invoice plan names are `Stocky Basic`, `Stocky Pro`, and `Stocky Plus`.
- CSV uploads accept Stocky export files, detect report type, persist raw CSV bytes and parsed rows, preserve unknown columns in row payloads, and record row-level warnings.
- Catalog sync uses the Shopify GraphQL Admin API with `read_products`, `read_inventory`, and `read_locations`.
- Audit findings are regenerated from uploaded Stocky rows and the latest synced Shopify catalog.
- Export downloads generate archive, SKU gap, supplier reconstruction, and migration checklist CSVs. Uploaded raw CSVs remain downloadable from the parsed files table.

## Environment

`SHOPIFY_APP_HANDLE` is required for Shopify's hosted App Pricing redirect and should be `stocky-escape-kit-1` for the current app.
`SHOPIFY_BILLING_TEST` defaults to test mode outside production unless set to `false`.
Set `SHOPIFY_BILLING_TEST=false` for production merchant installs.
`SHOPIFY_SYNC_VARIANT_LIMIT` defaults to `5000` variants per sync request.
`SHOPIFY_TEST_SHOP` is used only by the live Shopify smoke test.
`SHOPIFY_ADMIN_ACCESS_TOKEN` is optional and lets the live smoke test call
Shopify directly when no local Prisma session is available.
`SHOPIFY_PARTNER_ORG_ID`, `SHOPIFY_PARTNER_API_TOKEN`, and
`SHOPIFY_PARTNER_APP_ID` are required on the server for Shopify App Pricing
billing proof through the Partner API `activeSubscription` query. The Partner
API client must have Manage apps permission.

Partner Dashboard App Pricing must be configured before review:

- Public monthly billing plan names: `Stocky Basic`, `Stocky Pro`, `Stocky Plus`; use public listing display names `Stocky Escape Kit Basic`, `Stocky Escape Kit Pro`, and `Stocky Escape Kit Plus`.
- Private `$0` review/dev plan: Shopify exposes the reserved `shopify-test` plan; label it as `Stocky Escape Kit Review Test` wherever listing descriptions allow. This plan is accepted by smoke tests but must not be shown as public marketing.
- Welcome/return links should route back to `/app`.

## Verification

Run local static checks without Shopify credentials:

```sh
npm run risk:audit
```

`risk:audit` verifies static Shopify prerequisites, local parser/export
regression tests, Prisma schema validity, TypeScript, lint, and the production
build output. It fails if React Router future-flag warnings return.

Run live verification after installing the app on a development store:

```sh
npm run dev
# Complete Shopify CLI install on SHOPIFY_TEST_SHOP.
npm run smoke:shopify
```

The live smoke test loads `.env`, finds the offline session for
`SHOPIFY_TEST_SHOP` in Prisma or uses `SHOPIFY_ADMIN_ACCESS_TOKEN`, calls the
Shopify GraphQL Admin API for shop ID discovery, granted scopes, products, and
locations, then calls Shopify Partner API `activeSubscription` for App Pricing
billing proof. It does not print access tokens.

If live smoke fails before contacting Shopify, set `DATABASE_URL` and
`SHOPIFY_TEST_SHOP` in `.env` after installing the app, or set
`SHOPIFY_TEST_SHOP` plus `SHOPIFY_ADMIN_ACCESS_TOKEN` for direct Admin GraphQL
proof. Also set `SHOPIFY_PARTNER_ORG_ID`, `SHOPIFY_PARTNER_API_TOKEN`, and
`SHOPIFY_PARTNER_APP_ID` so billing can be verified through the Partner API.
Select the private `$0` review/dev plan in the dev/review store before
rerunning `npm run smoke:shopify`.

## Production Hosting

Render deployment setup is tracked in `render.yaml`. The expected low-maintenance
production setup is a Docker web service on the `starter` plan plus Render
Postgres `basic-1gb`.

See `docs/render-deployment.md` before creating or updating Render services.

## Public Pricing

- `Stocky Escape Kit Basic`: `$99/mo` migration archive and audit.
- `Stocky Escape Kit Pro`: `$199/mo` larger files, supplier reconstruction, all exports.
- `Stocky Escape Kit Plus`: `$299/mo` multi-location reports and priority migration checklist.

## Implementation Entry Point

Read `IMPLEMENTATION_PLAN.md` before scaffolding the Shopify app.
