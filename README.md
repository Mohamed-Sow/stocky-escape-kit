# Stocky Escape Kit

## Product Summary

Stocky Escape Kit is a Shopify public app for merchants migrating away from Stocky before the August 31, 2026 shutdown. The app preserves Stocky exports, audits migration gaps, reconstructs supplier hints, and produces Shopify-ready cleanup reports.

This app should not become full inventory management software in v1.

## Core Merchant Promise

"Back up your Stocky records, find what will not migrate cleanly, and get a clear action list before Stocky shuts down."

## MVP Outcomes

- Merchant uploads Stocky CSV exports.
- App parses and stores an archive of those exports.
- App matches Stocky rows to Shopify SKUs, products, variants, inventory items, and locations.
- App reports missing SKUs, duplicate SKUs, missing cost, missing barcode, missing vendor, unmatched locations, parse errors, and supplier reconstruction candidates.
- Merchant exports clean archive and migration reports.

## Implemented App Flow

- OAuth install/linking uses the official Shopify React Router app package and Prisma session storage.
- Billing uses one-time Shopify Billing API purchases for Basic, Pro, and Plus plans.
- CSV uploads accept Stocky export files, detect report type, persist parsed rows, preserve unknown columns in row payloads, and record row-level warnings.
- Catalog sync uses the Shopify GraphQL Admin API with `read_products`, `read_inventory`, and `read_locations`.
- Audit findings are regenerated from uploaded Stocky rows and the latest synced Shopify catalog.
- Export downloads generate archive, SKU gap, supplier reconstruction, and migration checklist CSVs.

## Environment

`SHOPIFY_BILLING_TEST` defaults to test mode outside production unless set to `false`.
`SHOPIFY_SYNC_VARIANT_LIMIT` defaults to `5000` variants per sync request.
`SHOPIFY_TEST_SHOP` is used only by the live Shopify smoke test.

## Verification

Run local static checks without Shopify credentials:

```sh
npm run risk:audit
```

`risk:audit` verifies static Shopify prerequisites, local parser/export
regression tests, TypeScript, lint, and the production build output. It fails if
React Router future-flag warnings return.

Run live verification after installing the app on a development store:

```sh
npm run dev
# Complete Shopify CLI install on SHOPIFY_TEST_SHOP.
npm run smoke:shopify
```

The live smoke test loads `.env`, finds the offline session for `SHOPIFY_TEST_SHOP`
in Prisma, calls the Shopify GraphQL Admin API, and verifies granted scopes,
active Stocky Escape Kit billing, product query access, and location query
access. It does not print access tokens.

If live smoke fails before contacting Shopify, set `DATABASE_URL` and
`SHOPIFY_TEST_SHOP` in `.env`, run the app install on that shop, approve a test
billing plan, and rerun `npm run smoke:shopify`.

## Suggested Pricing

- Basic: `$99` migration archive and audit.
- Pro: `$199` larger files, supplier reconstruction, all exports.
- Plus: `$299` multi-location reports and priority migration checklist.

## Implementation Entry Point

Read `IMPLEMENTATION_PLAN.md` before scaffolding the Shopify app.
