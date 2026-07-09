# Shopify Review Readiness

Do not submit until every item is checked in the Partner Dashboard and the live smoke passes against the review/dev store.

## App configuration

- [ ] App URL: `https://stocky-escape-kit.onrender.com`.
- [ ] Redirect URL: `https://stocky-escape-kit.onrender.com/auth/callback`.
- [ ] Health check URL: `https://stocky-escape-kit.onrender.com/healthz`.
- [ ] Optional hosted smoke URL: `https://stocky-escape-kit.onrender.com/ops/shopify-smoke`.
- [ ] Compliance webhooks are configured for `customers/data_request`, `customers/redact`, and `shop/redact`.
- [ ] API contact email is set and does not contain restricted Shopify-like wording.
- [ ] Emergency developer contact email and phone are set.
- [ ] Privacy policy URL is live and explains Shopify API data, direct merchant uploads, raw CSV retention, logs, deletion, and support contact.
- [ ] App icon is a 1200 x 1200 JPEG or PNG.
- [ ] Screenshots show upload, parsed files/raw archive, audit findings, Shopify catalog sync, and exports.

## Billing setup

- [ ] Shopify App Pricing is enabled.
- [ ] Public monthly plans are named exactly `Stocky Escape Kit Basic`, `Stocky Escape Kit Pro`, and `Stocky Escape Kit Plus`.
- [ ] Public prices are `$99/mo`, `$199/mo`, and `$299/mo`.
- [ ] Private `$0` review/dev plan is named exactly `Stocky Escape Kit Review Test`.
- [ ] Private review/dev plan is not described as public marketing.
- [ ] Welcome links return reviewers to `/app`.
- [ ] Production env has `SHOPIFY_APP_HANDLE=stocky-escape-kit-1` and `SHOPIFY_BILLING_TEST=false`.

## Reviewer flow

1. Install the app on the provided review/dev store.
2. Select the private `Stocky Escape Kit Review Test` plan from Shopify's hosted pricing page.
3. Open the embedded app and confirm billing shows the review test plan.
4. Upload CSV fixtures from `fixtures/stocky`, starting with `stocky-purchase-orders.csv`, `stocky-stocktakes.csv`, `stocky-historical-costs.csv`, and `stocky-vendors.csv`.
5. Confirm parsed files show row counts, warnings, and raw CSV download links.
6. Run Shopify catalog sync.
7. Review audit findings for SKU gaps, missing cost/barcode/vendor, supplier hints, and open purchase order indicators.
8. Download archive, SKU gap, supplier reconstruction, and migration checklist exports.

## Claims boundary

Allowed claims: Stocky CSV backup, raw archive, migration audit, supplier hints, and Shopify-ready cleanup exports.

Do not claim the app imports historical Stocky purchase orders into Shopify, replaces Stocky as inventory management, writes Shopify inventory, or uses REST Admin API.

## Final verification

```sh
npm run risk:audit
SHOPIFY_TEST_SHOP=stocky-escape-kit-partner-dev.myshopify.com npm run smoke:shopify
curl -fsS https://stocky-escape-kit.onrender.com/healthz
```
