# Mock Data Coverage

Real merchant Stocky exports are not broadly public. Public sources give enough
shape to build a hostile synthetic pack without copying private merchant data:

- Shopify product CSV documentation identifies common product export columns
  such as `SKU`, `Barcode`, `Cost per item`, and inventory quantity.
- Shopify's Stocky purchase order documentation describes CSV/PDF PO downloads
  and editable PO fields including shelf, aisle, base cost, quantity, invoice
  number, supplier order number, receive location, dates, and notes.
- Shopify's Stocky migration guidance calls out custom purchase order and
  transfer fields such as supplier reference numbers, internal/costing codes,
  lot or serial numbers, RFID identifiers, and freight or customs details.
- Stocktake export guidance describes product name, SKU, barcode, Shopify ID,
  retail price, cost price, expected stock, actual stock, and adjustment totals.
- Shopify's Stocky report guide describes historical stock-on-hand exports as
  date-based totals for cost, retail value, or quantity. It also describes
  adjustment evidence with date, reason, and employee fields, and transfer
  evidence with status, origin, destination, and reason fields.
- A public Stocky-to-vendor-cart ETL repository uses a Stocky purchase order CSV
  contract with `SKU`, `Qty Ordered`, `Cost (base)`, and `Total Cost (base)`,
  plus duplicate-SKU handling and configurable delimiters/quoting.

Sources:

- Shopify product CSV docs:
  https://help.shopify.com/en/manual/products/import-export/using-csv
- Shopify Stocky purchase order docs:
  https://help.shopify.com/en/manual/sell-in-person/shopify-pos/inventory-management/stocky/inventory-management/purchase-orders
- Shopify Stocky migration guidance:
  https://help.shopify.com/en/manual/products/inventory/transitioning-from-stocky
- Shopify stocktake export docs:
  https://help.shopify.com/en/manual/sell-in-person/shopify-pos/inventory-management/stocky/inventory-management/stocktakes
- Shopify Stocky report types:
  https://help.shopify.com/en/manual/sell-in-person/shopify-pos/inventory-management/stocky/reporting/report-types
- Fabrikator Stocky export guide:
  https://www.fabrikator.io/blog/how-to-export-data-from-stocky
- Public Stocky PO ETL repository:
  https://github.com/DrCBeatz/stocky_to_coast

The fixture pack under `fixtures/stocky/` translates those public patterns into
repeatable synthetic files that cover:

- Standard comma-separated Stocky-style exports.
- Semicolon- and tab-delimited files with CSV-like filenames.
- Unknown proprietary columns preserved in the archive payload.
- Duplicate proprietary headers preserved with suffixed raw keys.
- Missing SKU, duplicate SKU, malformed quoted CSV, odd SKU symbols, open PO
  statuses, supplier hints, location mismatches, and missing product metadata.
- Regression cases for the documented stocktake, aggregate historical
  stock-on-hand, adjustment, and transfer shapes. Current stock-on-hand and
  product-cost exports are explicitly kept out of historical coverage so they
  cannot create a false completeness signal.

These fixtures are not a substitute for beta testing with real Stocky exports,
but they are the baseline adversarial dataset for app review and regression
testing when real merchant files are unavailable.
