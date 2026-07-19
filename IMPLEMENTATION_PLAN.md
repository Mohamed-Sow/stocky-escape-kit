# Stocky Escape Kit Implementation Plan

## Summary

Build a Shopify-only public app that helps merchants preserve raw Stocky CSV exports, parsed rows, and metadata and prepare inventory workflows before Stocky stops working. Prioritize fast App Store submission, CSV reliability, and truthful migration guidance.

## Key Changes

- Scaffold a new Shopify app in this folder using the official React Router/Remix-style Shopify app template, TypeScript, Prisma, PostgreSQL, Polaris, App Bridge, and GraphQL Admin API.
- Implement OAuth install, embedded admin shell, Shopify App Pricing, uninstall cleanup, GDPR webhooks, and minimal scopes: `read_products`, `read_inventory`, `read_locations`.
- Add CSV upload flow for Stocky purchase orders, stocktakes, historical cost data, inventory activity, product/custom SKU reports, and any supplier evidence the merchant can preserve. Do not imply that Stocky supplier records can be exported directly.
- Build parser and normalizer modules that record upload batch, source file, parsed rows, parse warnings, unknown columns, and row-level validation issues.
- Use fully cursor-paginated Shopify GraphQL queries to fetch products, variants, inventory items, locations, SKUs, barcodes, vendor, and cost-related fields available to the app. Fail closed at the configured safety limit rather than auditing a partial catalog.
- Create audit reports for unmatched SKUs, duplicate SKUs, missing cost, missing barcode, missing vendor, location mismatches, open purchase order indicators, and supplier reconstruction candidates.
- Provide exports for the parsed archive, complete audit findings, supplier evidence, and migration checklist.
- Include the complete migration workflow on every paid tier. Differentiate plans by safe file, row, run, and retained-source capacity instead of artificial report locks.

## Data Model

- `Store`: shop domain, install status, scopes, last verified billing status and plan.
- `UploadBatch`: store, status, file count, imported row count, warning count.
- `UploadedFile`: batch, original filename, detected report type, parse status, raw CSV storage pointer, content hash, raw content bytes, parse metadata.
- `ParsedRecord`: file, normalized type, source row number, normalized payload, warnings.
- `ShopifyCatalogSnapshot`: store, sync status, product/variant/inventory summary.
- `AuditFinding`: store, batch, severity, category, SKU, title, message, recommended action.
- `ExportJob`: store, export type, status, generated file pointer.

## UX Flow

- Public first screen: shutdown deadline, truthful export guidance, and a Shopify-admin CTA; never ask the merchant to enter a shop domain.
- Upload screen: drag-and-drop CSVs, detected report types, parse warnings, retry.
- Audit dashboard: imported files, factual next action, critical gaps, supplier evidence, and export actions. Avoid an opaque readiness score.
- Finding detail: affected rows, matched Shopify records, recommended manual fix.
- Exports screen: downloadable reports and archive status.

## Validation

- Unit tests for CSV parser, report-type detection, SKU matching, duplicate detection, supplier reconstruction, and export generation.
- Fixture tests with missing columns, unknown columns, malformed dates, duplicate SKUs, multiple locations, invalid currency, and large files.
- Integration tests for OAuth, billing gate and outage fallback, Shopify GraphQL pagination/limit behavior, upload limits/lifecycle, and export job lifecycle.
- Manual App Store review path on a development store with sample CSVs and sample-data mode.

## Current Implementation Notes

- Live install/linking is handled by Shopify OAuth plus an `afterAuth` store upsert.
- Billing is configured through Shopify App Pricing, not in-app Billing API charge creation.
- Public monthly billing names are `Stocky Basic` (`$99/mo`), `Stocky Pro` (`$199/mo`), and `Stocky Plus` (`$299/mo`); public listing display names can use `Stocky Escape Kit Basic`, `Stocky Escape Kit Pro`, and `Stocky Escape Kit Plus`.
- The private `$0` review/dev plan is Shopify's reserved `shopify-test` plan; render it to merchants as `Stocky Review Test`. Treat Shopify's Partner API description `Shopify Test` as diagnostic evidence only. It is accepted by billing gates and smoke tests but is not public marketing.
- New unpaid merchants are redirected to Shopify's hosted pricing page using `SHOPIFY_APP_HANDLE=stocky-escape-kit-1`. Canceled merchants retain read-only access to existing evidence and the permanent reset control.
- Partner API outages use a bounded 24-hour grace period from the last verified active billing check; successful inactive responses are not treated as outages.
- Upload, parser, audit, catalog sync, and exports are implemented in server modules under `app/lib`.
- Upload and export ceilings are sized for the current 512 MB Render Starter web service. Per-file and per-run byte limits are paired with parsed-row limits so in-memory multipart parsing and report generation fail safely instead of exhausting the service.
- GraphQL catalog sync is cursor-paginated and capped by `SHOPIFY_SYNC_VARIANT_LIMIT` (5,000 variants by default and currently the supported merchant ceiling); exceeding the cap fails without regenerating findings from partial data. Stores above that ceiling need a bulk-sync implementation before they are supported.
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
