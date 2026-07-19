# Stocky CSV Mock Fixture Pack

These files are synthetic Stocky-style exports for parser, upload, audit, and
report testing. They do not contain real merchant data.

The pack intentionally covers:

- Products with quoted commas, multiline fields, duplicate SKUs, missing SKUs,
  unknown columns, and a column-count mismatch.
- Purchase orders with open, pending, partially received, and closed statuses.
- Stocktakes and inventory activity across matching and mismatched locations.
- Historical stock-on-hand or cost evidence with blank costs and old supplier evidence.
- Vendor/supplier-only exports that should preserve supplier hints without SKU
  matching.
- Unknown exports and malformed CSV that should remain diagnosable.
- A mock Shopify catalog summary with duplicate SKUs, missing metadata, and a
  smaller location set than the Stocky exports.
- Semicolon- and tab-delimited files that are still exported with CSV-like
  extensions.
- Proprietary/custom columns such as supplier references, lot/serial data, RFID
  identifiers, freight/customs notes, and duplicate internal-code headers.

Use these files when real Stocky exports are unavailable.
