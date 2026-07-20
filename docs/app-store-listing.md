# Shopify App Store Listing Draft

## App details

**App name:** Stocky Escape Kit

**Subtitle:** Preserve Stocky exports and audit migration gaps

**Promotional text:** Back up original Stocky CSV exports, compare them with your live Shopify catalog, find migration risks, and leave with a traceable migration package.

**Search terms:** Stocky migration, Stocky backup, CSV archive, SKU audit, supplier records, inventory migration

## Description

Stocky Escape Kit helps Shopify merchants preserve and review their Stocky data before shutdown.

Create one migration run from related Stocky CSV exports. The app retains every original file with a checksum, parses supported reports, and keeps unfamiliar columns as source evidence. A read-only Shopify catalog snapshot then identifies SKU, product-data, supplier, purchasing, and location issues that need attention.

Use Stocky Escape Kit to:

- Preserve original Stocky CSV files and raw download history.
- Review parsing warnings without losing malformed source files.
- Compare Stocky SKUs and reported location names with the current Shopify catalog.
- Find missing or duplicate SKUs, missing cost, barcode, or vendor data, and Stocky location names that do not exist in Shopify.
- Retain supplier hints and open-purchase-order evidence for manual review.
- Follow an operational cutover checklist for in-flight orders, replacement Shopify workflows, staff training, POS cleanup, and Stocky-dependent integrations.
- Download four focused CSV reports or one checksum-manifest migration record containing every preserved original CSV.

Stocky Escape Kit uses read-only access to products, inventory, and locations. It does not change Shopify data, replace inventory management, or import historical Stocky purchase orders into Shopify. Historical purchase orders are preserved and reviewed as migration evidence.

The location check verifies whether a location name found in a Stocky report exists among the store's current Shopify locations. It does not claim that a specific SKU is stocked there or compare per-location quantities.

Current catalog audits support stores with up to 5,000 Shopify variants. Larger catalogs stop before findings are generated, so the app never presents a partial catalog audit as complete.

## Feature bullets

- Raw Stocky CSV preservation with SHA-256 checksums
- Batch-scoped migration runs and upload history
- Read-only Shopify catalog comparison
- Searchable, human-readable migration findings
- Supplier evidence and migration checklist exports
- One ZIP migration record with original CSVs, generated reports, and checksums

## Pricing display names

Use these exact public display names in Shopify pricing fields:

- Stocky Escape Kit Basic
- Stocky Escape Kit Pro
- Stocky Escape Kit Plus

Do not place price amounts in listing copy. The private plan identity is `shopify-test`; the merchant-facing label is `Stocky Review Test`.

## Declarations and capabilities

- Protected customer data: not required. The app does not request customer scopes or process customer records.
- Shopify data: products, inventory, and locations through read-only GraphQL Admin API scopes.
- Merchant-provided data: Stocky CSV uploads, including raw bytes, parsed rows, metadata, and checksums.
- Write behavior: none. The app does not create or change Shopify products, inventory, locations, purchase orders, or customers.
- Primary capability: Stocky shutdown migration archive, catalog audit, supplier evidence review, and report export.

## Local review assets

- App icon: `docs/review-assets/app-icon-1200.png` (1200 x 1200 PNG)
- Screenshot set: `docs/review-assets/01-overview.png` through `docs/review-assets/05-exports.png`

Regenerate the screenshot set from the deployed build after the hardening changes and before App Store submission.
