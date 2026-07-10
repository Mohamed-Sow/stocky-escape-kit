# Reviewer Instructions

1. Install Stocky Escape Kit on the supplied review store and choose the private `shopify-test` plan. The embedded app displays this as **Stocky Review Test**.
2. Open **Files**. Choose or drag all ten `.csv` files from `fixtures/stocky` into the staging queue. Multiple file-picker passes should accumulate files. Submit the queue once.
3. Confirm one migration run is created with **10 files**, **38 imported rows**, **39 warnings**, and **1 expected failed file** (`stocky-malformed-unclosed-quote.csv`). Every file, including the malformed file, must have a raw archive download.
4. Select the new run and choose **Sync Shopify and audit**. The canonical review store should report **17 products, 26 variants, 26 inventory items, 28 inventory levels, and 2 locations**.
5. Open **Findings**. Confirm the selected run contains **62 findings**. Test severity and category filters, search for a SKU, and review the source filename/row plus recommended action.
6. Open **Exports**. Download the parsed archive, SKU gap report, supplier evidence, and migration checklist CSV files. Each must be non-empty and scoped to the selected run.
7. Download **Review kit**. Confirm the ZIP contains the same four CSV files and `manifest.json`; each manifest entry includes the filename, byte count, and SHA-256 checksum.
8. Return to **Files**, select an older run if available, and confirm its files, findings, and export history remain isolated from the canonical run.
9. Open **Settings** and inspect the retention explanation. Do not execute the reset on the review store.

Historical Stocky purchase orders are preserved and reviewed as evidence. They are not imported into Shopify. All Shopify access in this workflow is read-only and uses the GraphQL Admin API.
