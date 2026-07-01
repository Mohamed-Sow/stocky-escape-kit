# Stocky Escape Kit Implementation Plan

## Summary

Build a Shopify-only public app that helps merchants preserve Stocky exports and prepare inventory workflows before Stocky stops working. Prioritize fast App Store submission, CSV reliability, and truthful migration guidance.

## Key Changes

- Scaffold a new Shopify app in this folder using the official React Router/Remix-style Shopify app template, TypeScript, Prisma, PostgreSQL, Polaris, App Bridge, and GraphQL Admin API.
- Implement OAuth install, embedded admin shell, Shopify App Pricing or Billing API, uninstall cleanup, GDPR webhooks, and minimal scopes: `read_products`, `read_inventory`, `read_locations`.
- Add CSV upload flow for Stocky purchase orders, stocktakes, historical cost data, inventory activity, and any product/vendor-like exports the merchant has.
- Build parser and normalizer modules that record upload batch, source file, parsed rows, parse warnings, unknown columns, and row-level validation issues.
- Use Shopify GraphQL bulk operations to fetch products, variants, inventory items, inventory levels, locations, SKUs, barcodes, vendor, and cost-related fields available to the app.
- Create audit reports for unmatched SKUs, duplicate SKUs, missing cost, missing barcode, missing vendor, location mismatches, open purchase order indicators, and supplier reconstruction candidates.
- Provide exports for archive CSV, SKU gap report, supplier reconstruction report, and migration checklist.

## Data Model

- `Store`: shop domain, install status, scopes, billing status.
- `UploadBatch`: store, status, file count, imported row count, warning count.
- `UploadedFile`: batch, original filename, detected report type, parse status, storage pointer.
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

## Assumptions

- V1 is read-only against Shopify.
- No WooCommerce.
- No direct historical purchase order import claims.
- No AI required for v1.
- Object storage is used for uploaded CSVs and generated exports; database stores normalized rows and metadata.

