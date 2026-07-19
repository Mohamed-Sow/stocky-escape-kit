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
- [ ] Production `SUPPORT_EMAIL` is set to a monitored address and appears as a working `mailto:` link on `/support` and `/privacy`.
- [ ] Render Postgres has no `0.0.0.0/0` inbound rule; external access is disabled or limited to a temporary trusted `/32` address.
- [ ] Privacy policy URL is live and explains Shopify API data, direct merchant uploads, raw CSV retention, logs, deletion, and support contact.
- [ ] App icon is a 1200 x 1200 JPEG or PNG.
- [ ] Screenshots show upload, parsed files/raw archive, audit findings, Shopify catalog sync, and exports.
- [ ] Screenshots were regenerated from the currently deployed commit and show the visible 5,000-variant catalog boundary.

## Billing setup

- [ ] Shopify App Pricing is enabled.
- [ ] Public monthly invoice plans are named exactly `Stocky Basic`, `Stocky Pro`, and `Stocky Plus`.
- [ ] Public listing display names are `Stocky Escape Kit Basic`, `Stocky Escape Kit Pro`, and `Stocky Escape Kit Plus`.
- [ ] Public prices are `$99/mo`, `$199/mo`, and `$299/mo`.
- [ ] Private `$0` review/dev plan uses Shopify's reserved `shopify-test` identity and is rendered in the app as `Stocky Review Test`; Partner API description `Shopify Test` remains diagnostic evidence only.
- [ ] Private review/dev plan is not described as public marketing.
- [ ] Welcome links return reviewers to `/app`.
- [ ] Production env has `SHOPIFY_APP_HANDLE=stocky-escape-kit-1` and `SHOPIFY_BILLING_TEST=false`.
- [ ] Production env has `SHOPIFY_PARTNER_ORG_ID`, `SHOPIFY_PARTNER_API_TOKEN`, and `SHOPIFY_PARTNER_APP_ID` for Partner API `activeSubscription` billing proof.
- [ ] Partner API client has Manage apps permission.

## Reviewer flow

1. Install the app on the provided review/dev store.
2. Select the private `$0` review/dev plan from Shopify's hosted pricing page.
3. Open the embedded app and confirm billing shows the review test plan.
4. Stage all ten CSV files from `fixtures/stocky` and submit them together as one migration run.
5. Confirm the run shows 10 files, 38 imported rows, 34 warnings (including the deliberate duplicate-header warning), one expected malformed-file failure, and a raw CSV download for every file.
6. Run Shopify catalog sync.
7. Review audit findings for SKU gaps, missing cost/barcode/vendor, supplier hints, and open purchase order indicators.
8. Confirm the audit includes the deliberate duplicate-header, column-count, and malformed-file unknown-column parser findings, plus findings derived from the review store's current Shopify catalog. The exact total varies with that live catalog; the local canonical mock catalog produces 57 regression-test findings. Missing-SKU rows and open purchase orders should be grouped into actionable findings instead of repeated noise.
9. Download parsed archive, complete audit findings, supplier evidence, and migration checklist exports.
10. Download the migration-package ZIP and verify it contains all ten original CSV files under `source/`, the four generated reports, and `manifest.json` with byte counts and SHA-256 checksums.

## Claims boundary

Allowed claims: Stocky CSV backup, raw archive, migration audit, supplier hints, and Shopify-ready cleanup exports.

Do not claim the app imports historical Stocky purchase orders into Shopify, replaces Stocky as inventory management, writes Shopify inventory, or uses REST Admin API.

## Final verification

```sh
npm run risk:audit
SHOPIFY_TEST_SHOP=stocky-escape-kit-partner-dev.myshopify.com npm run smoke:shopify
curl -fsS https://stocky-escape-kit.onrender.com/healthz
```

The hosted endpoint is the preferred expiring-token proof. Run it twice after
deployment to prove refresh persistence. Direct Admin-token smoke is temporary
diagnostic proof only.
