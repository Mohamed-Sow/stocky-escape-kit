# Stocky Escape Kit

## Product Summary

Stocky Escape Kit is a Shopify public app for merchants migrating away from Stocky before the August 31, 2026 shutdown. The app preserves original Stocky CSV uploads plus parsed rows and metadata, audits migration gaps, reconstructs supplier evidence from purchase orders and custom SKU reports, and produces Shopify-ready cleanup reports. Stocky supplier records cannot be exported directly.

This app should not become full inventory management software in v1.

## Core Merchant Promise

"Back up your Stocky CSV exports, find what will not migrate cleanly, and get a clear action list before Stocky shuts down."

## MVP Outcomes

- Merchant uploads Stocky CSV exports.
- App stores raw uploaded CSV bytes, file hashes, normalized rows, unknown columns, and import metadata.
- App matches Stocky rows to Shopify SKUs, products, variants, and inventory items, and verifies Stocky-reported location names against current Shopify locations.
- App reports missing SKUs, duplicate SKUs, missing cost, missing barcode, missing vendor, Stocky location names absent from Shopify, parse errors, and supplier reconstruction candidates. It does not infer per-SKU location quantities.
- Merchant exports a clean archive, migration reports, and per-purchase-order
  Shopify line-item import files for open Stocky work that can be derived
  safely.

## Implemented App Flow

- OAuth install/linking uses the official Shopify React Router app package and Prisma session storage.
- Billing uses Shopify App Pricing subscriptions. Public listing display names are `Stocky Escape Kit Basic` at `$99/mo`, `Stocky Escape Kit Pro` at `$199/mo`, and `Stocky Escape Kit Plus` at `$299/mo`; Shopify's immutable invoice plan names are `Stocky Basic`, `Stocky Pro`, and `Stocky Plus`.
- CSV uploads accept UTF-8, UTF-16, and Windows-1252 Stocky exports, detect report type, persist the untouched raw bytes plus parsed rows, preserve unknown and duplicate columns, reject files with no header row, and enforce plan-specific file, row, run, and stored-data limits before unbounded database writes.
- Catalog sync uses the Shopify GraphQL Admin API with `read_products`, `read_inventory`, and `read_locations`.
- Catalog pagination either verifies the complete product-variant and location snapshot within the configured safety limit or fails without generating a partial audit.
- Audit findings are regenerated from uploaded Stocky rows and the latest synced Shopify catalog. Historical transaction rows are not misclassified as duplicate products, supplier-only evidence does not create false missing-SKU blockers, and malformed costs, quantities, dates, and row shapes become visible findings. The Findings screen searches and paginates the complete run rather than filtering only a truncated first page.
- Every active plan includes the parsed archive, complete audit findings, supplier evidence, migration checklist, location-name audit, and complete migration package. The package combines every preserved original CSV with all generated reports and a SHA-256 manifest. Plans differ by safe processing and storage capacity, not by withholding core migration outputs. Raw CSVs also remain individually downloadable from the parsed files table. If billing ends, existing runs remain downloadable and deletable; only new uploads and catalog syncs pause.
- The migration checklist verifies that Shopify's core historical report types—completed purchase orders, stocktake history, and historical stock-on-hand or cost reports—are represented, while treating product, custom SKU, and inventory activity reports as supplemental evidence. It explicitly warns that file presence cannot prove every intended date range or record was exported. The checklist also includes the operational cutover work Shopify cannot infer from read-only data: closing or recreating in-flight quantities, testing replacement Shopify workflows, training staff, removing the Stocky POS tile, and updating Stocky-dependent integrations.
- Open Stocky purchase orders produce a fail-closed handoff ZIP. Each safely
  identified purchase order gets its own CSV using Shopify's official `SKU,
Barcode, Supplier SKU, Quantity, Cost, Tax` import template. Partial,
  in-transit, duplicate, unidentified, or ambiguous-quantity lines are kept
  out of import files and listed in `manual-review-lines.csv`; closed,
  completed, canceled, voided, rejected, and fully received orders are
  excluded. A generic Stocky `Tax` column is never assumed to be Shopify's tax
  percentage. These files create draft line items only; they do not import
  historical Stocky purchase orders as Shopify history.
- A transient Partner API failure uses the last verified active billing state for at most 24 hours. A successful no-subscription response cancels access immediately; an outage cannot grant indefinite paid access.
- A canceled subscription remains read-only so the merchant can retrieve or delete existing evidence. Delivery of Shopify's `APP_UNINSTALLED` webhook deletes the store and all cascaded migration data.

## Environment

`SHOPIFY_APP_HANDLE` is required for Shopify's hosted App Pricing redirect and should be `stocky-escape-kit-1` for the current app.
`SHOPIFY_BILLING_TEST` defaults to test mode outside production unless set to `false`.
Set `SHOPIFY_BILLING_TEST=false` for production merchant installs.
`SHOPIFY_SYNC_VARIANT_LIMIT` defaults to `5000` variants per verified sync. That is the current supported catalog ceiling, not a plan benefit. If the catalog exceeds the limit, the sync fails closed instead of producing findings from a partial catalog; larger catalogs require a bulk-sync architecture before the app can be marketed to them.
`SHOPIFY_TEST_SHOP` is used only by the live Shopify smoke test.
`SHOPIFY_ADMIN_ACCESS_TOKEN` is optional and lets the live smoke test call
Shopify directly when no local Prisma session is available.
`SHOPIFY_PARTNER_ORG_ID`, `SHOPIFY_PARTNER_API_TOKEN`, and
`SHOPIFY_PARTNER_APP_ID` are required on the server for Shopify App Pricing
billing proof through the Partner API `activeSubscription` query. The Partner
API client must have Manage apps permission.
`SUPPORT_EMAIL` is required in production so the public support and privacy
pages expose a monitored merchant contact.

Partner Dashboard App Pricing must be configured before review:

- Public monthly billing plan names: `Stocky Basic`, `Stocky Pro`, `Stocky Plus`; use public listing display names `Stocky Escape Kit Basic`, `Stocky Escape Kit Pro`, and `Stocky Escape Kit Plus`.
- Private `$0` review/dev plan: Shopify exposes the reserved `shopify-test` plan; render it to merchants as `Stocky Review Test`. Treat the Partner API description `Shopify Test` as diagnostic evidence only. This plan is accepted by smoke tests but must not be shown as public marketing.
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

The preferred proof path is the authenticated hosted `/ops/shopify-smoke`
endpoint. It uses `unauthenticated.admin(shop)` from the official Shopify SDK,
which refreshes and persists expiring offline tokens before the route calls the
Admin GraphQL API. The local smoke script loads `.env`, uses the hosted endpoint
when configured, or uses `SHOPIFY_ADMIN_ACCESS_TOKEN` for temporary direct proof, calls the
Shopify GraphQL Admin API for shop ID discovery, granted scopes, products, and
locations, then calls Shopify Partner API `activeSubscription` for App Pricing
billing proof. It does not print access tokens.

If hosted smoke reports no offline session, reauthorize the installed app once.
If token refresh fails, verify the refresh-token session fields and Shopify app
credentials without exposing them. For temporary direct proof, set
`SHOPIFY_TEST_SHOP` plus `SHOPIFY_ADMIN_ACCESS_TOKEN`. Also set
`SHOPIFY_PARTNER_ORG_ID`, `SHOPIFY_PARTNER_API_TOKEN`, and
`SHOPIFY_PARTNER_APP_ID` so billing can be verified through the Partner API.
Select the private `$0` review/dev plan in the dev/review store before
rerunning `npm run smoke:shopify`.

## Production Hosting

Render deployment setup is tracked in `render.yaml`. The expected low-maintenance
production setup is a Docker web service on the `starter` plan plus Render
Postgres `basic-1gb`.

See `docs/render-deployment.md` before creating or updating Render services.

## Public Pricing

- `Stocky Escape Kit Basic`: `$99/mo`, up to 10 files, 5 MB per file, 10 MB combined, and 40,000 parsed rows per run; 100 MB stored source data.
- `Stocky Escape Kit Pro`: `$199/mo`, up to 20 files, 8 MB per file, 15 MB combined, and 60,000 parsed rows per run; 250 MB stored source data.
- `Stocky Escape Kit Plus`: `$299/mo`, up to 30 files, 10 MB per file, 20 MB combined, and 75,000 parsed rows per run; 500 MB stored source data.

All three plans include all four CSV reports, location mismatch analysis, the prioritized checklist, and the complete migration package. Request and row ceilings are intentionally bounded for the current 512 MB Render Starter web service. A synthetic 35 MB / 100,000-row parse exceeded 1 GB RSS, so those former ceilings are not safe on the paid production instance. Retained-source limits also account for base64 raw files, parsed JSON, indexes, and catalog snapshots sharing a 15 GB Postgres disk. A larger source report must be narrowed at export time when Stocky offers a suitable filter; otherwise the app needs a streaming worker and compute/storage upgrade before it can support that file truthfully.

Current catalog audits support stores with up to 5,000 Shopify variants on every plan. Stores above that ceiling are rejected before findings are regenerated; they are not shown a partial catalog as a complete audit.

## Implementation Entry Point

Read `IMPLEMENTATION_PLAN.md` before scaffolding the Shopify app.
