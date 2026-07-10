# Stocky Escape Kit Implementation Plan

## Summary

Build a Shopify-only public app that helps merchants preserve raw Stocky CSV exports, parsed rows, and metadata and prepare inventory workflows before Stocky stops working. Prioritize fast App Store submission, CSV reliability, and truthful migration guidance.

## Key Changes

- Scaffold a new Shopify app in this folder using the official React Router/Remix-style Shopify app template, TypeScript, Prisma, PostgreSQL, Polaris, App Bridge, and GraphQL Admin API.
- Implement OAuth install, embedded admin shell, Shopify App Pricing, uninstall cleanup, GDPR webhooks, and minimal scopes: `read_products`, `read_inventory`, `read_locations`.
- Add CSV upload flow for Stocky purchase orders, stocktakes, historical cost data, inventory activity, and any product/vendor-like exports the merchant has.
- Build parser and normalizer modules that record upload batch, source file, parsed rows, parse warnings, unknown columns, and row-level validation issues.
- Use Shopify GraphQL bulk operations to fetch products, variants, inventory items, inventory levels, locations, SKUs, barcodes, vendor, and cost-related fields available to the app.
- Create audit reports for unmatched SKUs, duplicate SKUs, missing cost, missing barcode, missing vendor, location mismatches, open purchase order indicators, and supplier reconstruction candidates.
- Provide exports for archive CSV, SKU gap report, supplier reconstruction report, and migration checklist.

## Data Model

- `Store`: shop domain, install status, scopes, billing status.
- `UploadBatch`: store, status, file count, imported row count, warning count.
- `UploadedFile`: batch, original filename, detected report type, parse status, raw CSV storage pointer, content hash, raw content bytes, parse metadata.
- `ParsedRecord`: file, normalized type, source row number, normalized payload, warnings.
- `ShopifyCatalogSnapshot`: store, sync status, product/variant/inventory summary.
- `AuditFinding`: store, batch, severity, category, SKU, title, message, recommended action.
- `ExportJob`: store, export type, status, generated file pointer.

## UX Flow

- First screen: shutdown deadline, what to export from Stocky, and upload CTA.
- Upload screen: drag-and-drop CSVs, detected report types, parse warnings, retry.
- Audit dashboard: readiness score, imported files, critical gaps, supplier reconstruction, export actions.
- Finding detail: affected rows, matched Shopify records, recommended manual fix.
- Exports screen: downloadable reports and archive status.

## Validation

- Unit tests for CSV parser, report-type detection, SKU matching, duplicate detection, supplier reconstruction, and export generation.
- Fixture tests with missing columns, unknown columns, malformed dates, duplicate SKUs, multiple locations, invalid currency, and large files.
- Integration tests for OAuth, billing gate, Shopify GraphQL sync mocks, upload lifecycle, and export job lifecycle.
- Manual App Store review path on a development store with sample CSVs and sample-data mode.

## Current Implementation Notes

- Live install/linking is handled by Shopify OAuth plus an `afterAuth` store upsert.
- Billing is configured through Shopify App Pricing, not in-app Billing API charge creation.
- Public monthly billing names are `Stocky Basic` (`$99/mo`), `Stocky Pro` (`$199/mo`), and `Stocky Plus` (`$299/mo`); public listing display names can use `Stocky Escape Kit Basic`, `Stocky Escape Kit Pro`, and `Stocky Escape Kit Plus`.
- The private `$0` review/dev plan is Shopify's reserved `shopify-test` plan; render it to merchants as `Stocky Review Test`. Treat Shopify's Partner API description `Shopify Test` as diagnostic evidence only. It is accepted by billing gates and smoke tests but is not public marketing.
- Unpaid merchants are redirected to Shopify's hosted pricing page using `SHOPIFY_APP_HANDLE=stocky-escape-kit-1`.
- Upload, parser, audit, catalog sync, and exports are implemented in server modules under `app/lib`.
- GraphQL catalog sync is cursor-paginated and capped by `SHOPIFY_SYNC_VARIANT_LIMIT` to keep embedded actions bounded.
- The app remains read-only against Shopify and does not claim historical Stocky purchase orders can be imported into Shopify.
- React Router v8 future flags are enabled in `react-router.config.ts` to remove build-time future-warning drift.
- Live Shopify verification is covered by `npm run smoke:shopify`, with either a Prisma offline session or `SHOPIFY_ADMIN_ACCESS_TOKEN`; `npm run smoke:shopify:static` is available for credential-free prerequisite checks.
- `npm run risk:audit` is the local risk gate: static Shopify smoke, local regression tests, Prisma schema validation, typecheck, lint, and production build-output inspection for React Router future-warning regressions. The static smoke fails if one-time purchase billing paths return.

## Assumptions

- V1 is read-only against Shopify.
- No WooCommerce.
- No direct historical purchase order import claims.
- No AI required for v1.
- Current v1 stores raw uploaded CSV bytes in Postgres as base64, plus file hashes, parsed rows, unknown columns, and import metadata.
