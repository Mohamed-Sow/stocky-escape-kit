import assert from "node:assert/strict";
import test from "node:test";
import { BillingStatus, StockyReportType } from "@prisma/client";
import { readCatalogSummary } from "../app/lib/catalog.server";
import { parseCsv, toCsv } from "../app/lib/csv.server";
import {
  BILLING_PLAN_NAMES,
  getActiveBillingName,
  isBillingTestMode,
  isValidBillingPlan,
} from "../app/models/billing.server";
import {
  normalizeHeader,
  parseStockyCsv,
} from "../app/lib/stocky-parser.server";

test("CSV parser preserves quoted commas, newlines, and escaped quotes", () => {
  const csv = 'SKU,Title,Notes\n"ABC,1","Line\nBreak","He said ""yes"""';

  assert.deepEqual(parseCsv(csv), {
    headers: ["SKU", "Title", "Notes"],
    rows: [
      {
        sourceRowNumber: 2,
        values: ["ABC,1", "Line\nBreak", 'He said "yes"'],
      },
    ],
    errors: [],
  });

  assert.equal(
    toCsv([
      ["SKU", "Title", "Notes"],
      ["ABC,1", "Line\nBreak", 'He said "yes"'],
    ]),
    'SKU,Title,Notes\n"ABC,1","Line\nBreak","He said ""yes"""',
  );
});

test("Stocky parser detects product exports and preserves unknown columns", () => {
  const parsed = parseStockyCsv({
    filename: "stocky-products.csv",
    content:
      "SKU,Product Name,Vendor,Barcode,Custom Shelf\nABC-1,Widget,Acme,12345,Aisle 7",
  });
  const [record] = parsed.records;

  assert.equal(parsed.reportType, StockyReportType.PRODUCTS);
  assert.equal(parsed.rowCount, 1);
  assert.deepEqual(parsed.unknownColumns, ["Custom Shelf"]);
  assert.equal(record.sku, "ABC-1");
  assert.deepEqual(record.warnings, []);
  assert.deepEqual(record.normalizedPayload.normalized, {
    sku: "ABC-1",
    title: "Widget",
    barcode: "12345",
    vendor: "Acme",
    supplier: null,
    location: null,
    cost: null,
    quantity: null,
    status: null,
    date: null,
    reference: null,
  });
  assert.deepEqual(record.normalizedPayload.meta, {
    headers: ["SKU", "Product Name", "Vendor", "Barcode", "Custom Shelf"],
    unknownColumns: ["Custom Shelf"],
  });
});

test("Stocky parser records missing SKU warnings without dropping rows", () => {
  const parsed = parseStockyCsv({
    filename: "purchase-orders.csv",
    content: "PO Number,Status,Supplier,Product Name\nPO-9,Open,Acme,Widget",
  });

  assert.equal(parsed.reportType, StockyReportType.PURCHASE_ORDERS);
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].sku, null);
  assert.deepEqual(parsed.records[0].warnings, ["missing_sku"]);
  assert.equal(parsed.warningCount, 1);
});

test("header normalization is stable across punctuation and whitespace", () => {
  assert.equal(normalizeHeader(" Product / SKU "), "product_sku");
  assert.equal(normalizeHeader("PO # Number"), "po_number");
});

test("catalog summary reader rejects invalid payloads and accepts variant arrays", () => {
  assert.equal(readCatalogSummary(null), null);
  assert.equal(readCatalogSummary({ generatedAt: "now" }), null);

  const summary = {
    generatedAt: "2026-07-01T00:00:00.000Z",
    truncated: false,
    limit: 5000,
    variants: [
      {
        id: "gid://shopify/ProductVariant/1",
        sku: "ABC-1",
        barcode: null,
        displayName: "Widget",
        productId: "gid://shopify/Product/1",
        productTitle: "Widget",
        vendor: "Acme",
        inventoryItemId: "gid://shopify/InventoryItem/1",
        inventorySku: "ABC-1",
        unitCost: { amount: "3.50", currencyCode: "USD" },
        locations: [],
      },
    ],
    duplicateSkus: [],
    locations: [],
  };

  assert.deepEqual(readCatalogSummary(summary), summary);
});

test("billing helpers validate configured plan names and active purchase names", () => {
  assert.equal(BILLING_PLAN_NAMES.length, 3);
  assert.equal(isValidBillingPlan("Stocky Escape Kit Pro"), true);
  assert.equal(isValidBillingPlan("Other Plan"), false);
  assert.equal(
    getActiveBillingName({
      hasActivePayment: true,
      oneTimePurchases: [
        {
          id: "gid://shopify/AppPurchaseOneTime/1",
          name: "Stocky Escape Kit Basic",
          status: "ACTIVE",
          test: true,
        },
      ],
      appSubscriptions: [],
    }),
    "Stocky Escape Kit Basic",
  );
});

test("billing test mode defaults safely outside production", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalBillingTest = process.env.SHOPIFY_BILLING_TEST;

  try {
    process.env.NODE_ENV = "development";
    delete process.env.SHOPIFY_BILLING_TEST;
    assert.equal(isBillingTestMode(), true);

    process.env.NODE_ENV = "production";
    process.env.SHOPIFY_BILLING_TEST = "false";
    assert.equal(isBillingTestMode(), false);

    process.env.SHOPIFY_BILLING_TEST = "true";
    assert.equal(isBillingTestMode(), true);
  } finally {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }

    if (originalBillingTest === undefined) {
      delete process.env.SHOPIFY_BILLING_TEST;
    } else {
      process.env.SHOPIFY_BILLING_TEST = originalBillingTest;
    }
  }
});

test("Prisma billing enum still contains app statuses used by store updates", () => {
  assert.equal(BillingStatus.ACTIVE, "ACTIVE");
  assert.equal(BillingStatus.NOT_STARTED, "NOT_STARTED");
});
