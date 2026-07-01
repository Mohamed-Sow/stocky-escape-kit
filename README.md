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

## Suggested Pricing

- Basic: `$99` migration archive and audit.
- Pro: `$199` larger files, supplier reconstruction, all exports.
- Plus: `$299` multi-location reports and priority migration checklist.

## Implementation Entry Point

Read `IMPLEMENTATION_PLAN.md` before scaffolding the Shopify app.

