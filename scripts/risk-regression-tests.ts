import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  BillingStatus,
  ExportStatus,
  ExportType,
  FileParseStatus,
  FindingCategory,
  FindingSeverity,
  StockyReportType,
  SyncStatus,
  UploadBatchStatus,
} from "@prisma/client";
import type { Prisma } from "@prisma/client";
import db from "../app/db.server";
import { regenerateAuditFindings } from "../app/lib/audit.server";
import { readCatalogSummary } from "../app/lib/catalog.server";
import { parseCsv, toCsv } from "../app/lib/csv.server";
import { generateExport } from "../app/lib/exports.server";
import {
  BILLING_PLAN_NAMES,
  PRIVATE_TEST_BILLING_DISPLAY_NAME,
  PRIVATE_TEST_BILLING_PLAN,
  getPlanSelectionUrl,
  getActiveBillingName,
  hasActiveBillingSubscription,
  isBillingTestMode,
  isValidBillingPlan,
} from "../app/models/billing.server";
import { importStockyCsvFiles } from "../app/lib/uploads.server";
import {
  normalizeHeader,
  parseStockyCsv,
} from "../app/lib/stocky-parser.server";

const STOCKY_FIXTURE_DIR = path.join(process.cwd(), "fixtures", "stocky");

function readStockyFixture(filename: string) {
  return readFileSync(path.join(STOCKY_FIXTURE_DIR, filename), "utf8");
}

function parseStockyFixture(filename: string) {
  return parseStockyCsv({
    filename,
    content: readStockyFixture(filename),
  });
}

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

test("CSV export neutralizes spreadsheet formula injection values", () => {
  assert.equal(
    toCsv([
      ["sku", "supplier", "quantity", "note"],
      ["=cmd|' /C calc'!A0", "+SUM(1,2)", "-2", "@hidden"],
      [" safe", "  =HYPERLINK(\"https://example.com\")", "\t=1+1", "plain"],
    ]),
    [
      "sku,supplier,quantity,note",
      "'=cmd|' /C calc'!A0,\"'+SUM(1,2)\",'-2,'@hidden",
      " safe,\"'  =HYPERLINK(\"\"https://example.com\"\")\",'\t=1+1,plain",
    ].join("\n"),
  );
});

test("CSV parser accepts semicolon and tab-delimited exports", () => {
  assert.deepEqual(parseCsv('SKU;Notes\nABC;"contains; delimiter"'), {
    headers: ["SKU", "Notes"],
    rows: [
      {
        sourceRowNumber: 2,
        values: ["ABC", "contains; delimiter"],
      },
    ],
    errors: [],
  });

  assert.deepEqual(parseCsv("SKU\tQty\nABC\t12"), {
    headers: ["SKU", "Qty"],
    rows: [
      {
        sourceRowNumber: 2,
        values: ["ABC", "12"],
      },
    ],
    errors: [],
  });
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

test("billing helpers validate configured App Pricing subscription names", () => {
  assert.equal(BILLING_PLAN_NAMES.length, 8);
  assert.equal(isValidBillingPlan("Stocky Pro"), true);
  assert.equal(isValidBillingPlan("Stocky Escape Kit Pro"), true);
  assert.equal(isValidBillingPlan(PRIVATE_TEST_BILLING_PLAN), true);
  assert.equal(isValidBillingPlan(PRIVATE_TEST_BILLING_DISPLAY_NAME), true);
  assert.equal(isValidBillingPlan("Other Plan"), false);

  const activeSubscription = {
    id: "gid://shopify/AppSubscription/1",
    name: "Stocky Basic",
    status: "ACTIVE" as const,
    test: false,
    trialDays: 0,
    createdAt: "2026-07-08T00:00:00Z",
    currentPeriodEnd: "2026-08-08T00:00:00Z",
    returnUrl: "https://stocky-escape-kit.onrender.com/app",
    lineItems: [],
  };

  assert.equal(
    getActiveBillingName({
      hasActivePayment: true,
      oneTimePurchases: [],
      appSubscriptions: [activeSubscription],
    }),
    "Stocky Basic",
  );
  assert.equal(
    hasActiveBillingSubscription({
      hasActivePayment: true,
      oneTimePurchases: [],
      appSubscriptions: [
        {
          ...activeSubscription,
          name: PRIVATE_TEST_BILLING_PLAN,
          test: true,
        },
      ],
    }),
    true,
  );
  assert.equal(
    hasActiveBillingSubscription({
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
    false,
  );
  assert.equal(
    hasActiveBillingSubscription({
      hasActivePayment: true,
      oneTimePurchases: [],
      appSubscriptions: [
        {
          ...activeSubscription,
          name: "Another App Subscription",
        },
      ],
    }),
    false,
  );
  assert.equal(
    hasActiveBillingSubscription({
      hasActivePayment: false,
      oneTimePurchases: [],
      appSubscriptions: [activeSubscription],
    }),
    false,
  );
  assert.equal(
    getActiveBillingName({
      hasActivePayment: false,
      oneTimePurchases: [],
      appSubscriptions: [activeSubscription],
    }),
    null,
  );

  const originalAppHandle = process.env.SHOPIFY_APP_HANDLE;
  try {
    delete process.env.SHOPIFY_APP_HANDLE;
    assert.equal(
      getPlanSelectionUrl("stocky-escape-kit-partner-dev.myshopify.com"),
      "https://admin.shopify.com/store/stocky-escape-kit-partner-dev/charges/stocky-escape-kit-1/pricing_plans",
    );
  } finally {
    if (originalAppHandle === undefined) {
      delete process.env.SHOPIFY_APP_HANDLE;
    } else {
      process.env.SHOPIFY_APP_HANDLE = originalAppHandle;
    }
  }
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

test("mock Stocky fixture pack covers every supported report type", () => {
  const expected = new Map([
    ["stocky-products-edge-cases.csv", StockyReportType.PRODUCTS],
    ["stocky-shopify-products-tab-export.csv", StockyReportType.PRODUCTS],
    ["stocky-po-proprietary-semicolon.csv", StockyReportType.PURCHASE_ORDERS],
    ["stocky-purchase-orders.csv", StockyReportType.PURCHASE_ORDERS],
    ["stocky-stocktakes.csv", StockyReportType.STOCKTAKES],
    ["stocky-inventory-activity.csv", StockyReportType.INVENTORY_ACTIVITY],
    ["stocky-historical-costs.csv", StockyReportType.HISTORICAL_COSTS],
    ["stocky-vendors.csv", StockyReportType.VENDORS],
    ["stocky-unknown-export.csv", StockyReportType.UNKNOWN],
    ["stocky-malformed-unclosed-quote.csv", StockyReportType.PRODUCTS],
  ]);

  const fixtureCsvs = readdirSync(STOCKY_FIXTURE_DIR)
    .filter((filename) => filename.endsWith(".csv"))
    .sort();

  assert.deepEqual(fixtureCsvs, [...expected.keys()].sort());

  for (const [filename, reportType] of expected) {
    const parsed = parseStockyFixture(filename);
    assert.equal(parsed.reportType, reportType, filename);
    assert.ok(parsed.rowCount > 0, filename);
  }
});

test("product fixture preserves hard CSV and Stocky edge cases", () => {
  const parsed = parseStockyFixture("stocky-products-edge-cases.csv");

  assert.equal(parsed.rowCount, 8);
  assert.deepEqual(parsed.unknownColumns, ["Reorder Point", "Notes"]);

  const filterRecord = parsed.records.find(
    (record) => record.sku === "SE-FILTER-2",
  );
  assert.ok(filterRecord);
  assert.equal(
    getNormalized(filterRecord, "title"),
    "Replacement Filter\n2-Pack",
  );
  assert.equal(getRaw(filterRecord, "Notes"), "Multiline Stocky note");

  assert.equal(
    parsed.records.filter((record) => record.sku === "DUP-100").length,
    2,
  );
  assert.ok(
    parsed.records.some((record) => record.warnings.includes("missing_sku")),
  );

  const mismatchedRecord = parsed.records.find(
    (record) => record.sku === "BROKEN-COL",
  );
  assert.ok(mismatchedRecord);
  assert.deepEqual(mismatchedRecord.warnings, ["column_count_mismatch"]);
});

test("proprietary delimiter fixtures preserve odd Stocky and Shopify columns", () => {
  const proprietaryPo = parseStockyFixture(
    "stocky-po-proprietary-semicolon.csv",
  );

  assert.equal(proprietaryPo.rowCount, 3);
  assert.deepEqual(proprietaryPo.unknownColumns, [
    "Total Cost (base)",
    "Lot / Serial",
    "RFID Tag",
    "Freight & Customs",
    "Internal Code",
    "Internal Code",
  ]);

  const firstPoRecord = proprietaryPo.records[0];
  assert.equal(firstPoRecord.sku, "PLUS+SKU.1");
  assert.equal(getNormalized(firstPoRecord, "reference"), "PO-2001");
  assert.equal(getNormalized(firstPoRecord, "status"), "Not received");
  assert.equal(getNormalized(firstPoRecord, "supplier"), "SUP-REF-771");
  assert.equal(getNormalized(firstPoRecord, "quantity"), "6");
  assert.equal(getNormalized(firstPoRecord, "cost"), "12,50");
  assert.equal(getNormalized(firstPoRecord, "location"), "Main Warehouse");
  assert.equal(
    getRaw(firstPoRecord, "Freight & Customs"),
    "Duties; ocean freight",
  );
  assert.equal(getRaw(firstPoRecord, "Internal Code"), "DEPT-17");
  assert.equal(getRaw(firstPoRecord, "Internal Code #2"), "BUYER-ALPHA");
  assert.deepEqual(getMeta(firstPoRecord).duplicateHeaders, ["Internal Code"]);

  const tabProductExport = parseStockyFixture(
    "stocky-shopify-products-tab-export.csv",
  );

  assert.equal(tabProductExport.rowCount, 3);
  assert.deepEqual(tabProductExport.unknownColumns, [
    "Handle",
    "Variant Inventory Policy",
  ]);

  const firstProductRecord = tabProductExport.records[0];
  assert.equal(firstProductRecord.sku, "SE-KETTLE-1");
  assert.equal(getNormalized(firstProductRecord, "barcode"), "012345678901");
  assert.equal(getNormalized(firstProductRecord, "cost"), "18.45");
  assert.equal(getNormalized(firstProductRecord, "quantity"), "18");
  assert.ok(
    tabProductExport.records.some((record) =>
      record.warnings.includes("missing_sku"),
    ),
  );
});

test("fixture pack captures report-specific migration risks", () => {
  const purchaseOrders = parseStockyFixture("stocky-purchase-orders.csv");
  const openStatuses = purchaseOrders.records
    .map((record) => getNormalized(record, "status"))
    .filter((status) => status && status !== "Received");
  assert.deepEqual(openStatuses, [
    "Open",
    "Partially Received",
    "Ordered",
    "Pending",
  ]);
  assert.ok(
    purchaseOrders.records.some((record) =>
      record.warnings.includes("missing_sku"),
    ),
  );

  const stocktakes = parseStockyFixture("stocky-stocktakes.csv");
  const negativeAdjustment = stocktakes.records.find(
    (record) => record.sku === "NEG-ADJ",
  );
  assert.ok(negativeAdjustment);
  assert.equal(getNormalized(negativeAdjustment, "quantity"), "-2");
  assert.equal(getNormalized(negativeAdjustment, "location"), "Returns Desk");

  const inventoryActivity = parseStockyFixture("stocky-inventory-activity.csv");
  assert.ok(
    inventoryActivity.records.some((record) =>
      record.warnings.includes("missing_sku"),
    ),
  );

  const costs = parseStockyFixture("stocky-historical-costs.csv");
  const blankCost = costs.records.find((record) => record.sku === "NO-COST");
  assert.ok(blankCost);
  assert.equal(getNormalized(blankCost, "cost"), null);

  const vendors = parseStockyFixture("stocky-vendors.csv");
  assert.deepEqual(vendors.unknownColumns, [
    "Email",
    "Phone",
    "Payment Terms",
    "Last Ordered At",
  ]);
  assert.equal(vendors.warningCount, 8);

  const unknown = parseStockyFixture("stocky-unknown-export.csv");
  assert.equal(unknown.reportType, StockyReportType.UNKNOWN);
  assert.deepEqual(unknown.unknownColumns, ["Export Label", "Freeform Value"]);

  const malformed = parseStockyFixture("stocky-malformed-unclosed-quote.csv");
  assert.deepEqual(malformed.parseErrors, [
    "CSV ended before a quoted field was closed.",
  ]);
});

test("mock Shopify catalog fixture validates audit-risk shape", () => {
  const summary = readCatalogSummary(
    JSON.parse(readStockyFixture("mock-shopify-catalog-summary.json")),
  );

  assert.ok(summary);
  assert.equal(summary.variants.length, 6);
  assert.deepEqual(
    summary.locations.map((location) => location.name),
    ["Main Warehouse", "Retail Floor"],
  );
  assert.deepEqual(summary.duplicateSkus, [
    {
      sku: "DUP-100",
      count: 2,
      variants: ["Basecamp Mug / White", "Basecamp Mug / Blue"],
    },
  ]);

  const duplicateVariants = summary.variants.filter(
    (variant) => variant.sku === "DUP-100",
  );
  assert.equal(duplicateVariants.length, 2);
  assert.ok(duplicateVariants.some((variant) => !variant.unitCost));
  assert.ok(duplicateVariants.some((variant) => !variant.barcode));
  assert.ok(duplicateVariants.some((variant) => !variant.vendor));
});

test("merchant workflow imports fixture batches, audits against catalog, and exports reports", async () => {
  const fakeDb = installInMemoryPrisma();
  const store = fakeDb.createStore("fixture-stocky-dev.myshopify.com");
  const fixtureFilenames = readdirSync(STOCKY_FIXTURE_DIR)
    .filter((filename) => filename.endsWith(".csv"))
    .sort();
  const fixtureStats = fixtureFilenames.map((filename) => ({
    filename,
    parsed: parseStockyFixture(filename),
  }));
  const expectedImportedRows = fixtureStats
    .filter(({ parsed }) => parsed.parseErrors.length === 0)
    .reduce((sum, { parsed }) => sum + parsed.rowCount, 0);
  const expectedWarnings = fixtureStats.reduce(
    (sum, { parsed }) => sum + parsed.warningCount,
    0,
  );

  try {
    const result = await importStockyCsvFiles({
      storeId: store.id,
      files: fixtureFilenames.map(
        (filename) =>
          new File([readStockyFixture(filename)], filename, {
            type: "text/csv",
          }),
      ),
    });

    assert.equal(result.fileCount, fixtureFilenames.length);
    assert.equal(result.failedFileCount, 1);
    assert.equal(result.importedRowCount, expectedImportedRows);
    assert.equal(result.warningCount, expectedWarnings);

    const [batch] = fakeDb.state.uploadBatches;
    assert.equal(batch.status, UploadBatchStatus.IMPORTED);
    assert.equal(batch.fileCount, fixtureFilenames.length);
    assert.equal(batch.importedRowCount, expectedImportedRows);
    assert.equal(fakeDb.state.uploadedFiles.length, fixtureFilenames.length);
    assert.equal(fakeDb.state.parsedRecords.length, expectedImportedRows);

    const edgeCaseContent = readStockyFixture("stocky-products-edge-cases.csv");
    const edgeCaseFile = fakeDb.state.uploadedFiles.find(
      (file) => file.originalFilename === "stocky-products-edge-cases.csv",
    );
    assert.ok(edgeCaseFile);
    assert.equal(
      Buffer.from(edgeCaseFile.rawContentBase64 ?? "", "base64").toString(
        "utf8",
      ),
      edgeCaseContent,
    );
    assert.equal(
      edgeCaseFile.rawContentByteLength,
      Buffer.byteLength(edgeCaseContent),
    );
    assert.equal(
      edgeCaseFile.contentSha256,
      createHash("sha256").update(Buffer.from(edgeCaseContent)).digest("hex"),
    );
    assert.equal(
      edgeCaseFile.storagePointer,
      `db:uploaded_file.rawContentBase64:sha256:${edgeCaseFile.contentSha256}`,
    );

    const failedFile = fakeDb.state.uploadedFiles.find(
      (file) => file.originalFilename === "stocky-malformed-unclosed-quote.csv",
    );
    assert.ok(failedFile);
    assert.equal(failedFile.parseStatus, FileParseStatus.FAILED);
    assert.equal(failedFile.rowCount, 0);
    assert.match(failedFile.errorMessage ?? "", /quoted field was closed/);

    const proprietaryFile = fakeDb.state.uploadedFiles.find(
      (file) => file.originalFilename === "stocky-po-proprietary-semicolon.csv",
    );
    assert.ok(proprietaryFile);
    assert.equal(
      proprietaryFile.detectedReportType,
      StockyReportType.PURCHASE_ORDERS,
    );
    assert.equal(proprietaryFile.rowCount, 3);

    const proprietaryRecord = fakeDb.state.parsedRecords.find(
      (record) => record.sku === "PLUS+SKU.1",
    );
    assert.ok(proprietaryRecord);
    const proprietaryPayload = readRecordPayload(proprietaryRecord);
    assert.equal(
      proprietaryPayload.raw?.["Freight & Customs"],
      "Duties; ocean freight",
    );
    assert.equal(proprietaryPayload.raw?.["Internal Code"], "DEPT-17");
    assert.equal(proprietaryPayload.raw?.["Internal Code #2"], "BUYER-ALPHA");
    assert.deepEqual(proprietaryPayload.meta?.duplicateHeaders, [
      "Internal Code",
    ]);
    assert.deepEqual(proprietaryPayload.meta?.unknownColumns, [
      "Total Cost (base)",
      "Lot / Serial",
      "RFID Tag",
      "Freight & Customs",
      "Internal Code",
      "Internal Code",
    ]);

    const tabDelimitedFile = fakeDb.state.uploadedFiles.find(
      (file) =>
        file.originalFilename === "stocky-shopify-products-tab-export.csv",
    );
    assert.ok(tabDelimitedFile);
    assert.equal(tabDelimitedFile.rowCount, 3);

    const catalog = readCatalogSummary(
      JSON.parse(readStockyFixture("mock-shopify-catalog-summary.json")),
    );
    assert.ok(catalog);
    fakeDb.seedCatalogSnapshot({
      storeId: store.id,
      summary: catalog,
    });

    const auditResult = await regenerateAuditFindings({
      storeId: store.id,
      batchId: result.batchId,
    });
    assert.ok(auditResult.created > 0);

    const categories = new Set(
      fakeDb.state.auditFindings.map((finding) => finding.category),
    );
    for (const category of [
      FindingCategory.MISSING_SKU,
      FindingCategory.UNMATCHED_SHOPIFY_SKU,
      FindingCategory.DUPLICATE_SKU,
      FindingCategory.MISSING_COST,
      FindingCategory.MISSING_BARCODE,
      FindingCategory.MISSING_VENDOR,
      FindingCategory.LOCATION_MISMATCH,
      FindingCategory.OPEN_PURCHASE_ORDER_INDICATOR,
      FindingCategory.SUPPLIER_RECONSTRUCTION_CANDIDATE,
      FindingCategory.PARSE_ERROR,
    ]) {
      assert.equal(categories.has(category), true, category);
    }
    assert.ok(
      fakeDb.state.auditFindings.some(
        (finding) => finding.severity === FindingSeverity.CRITICAL,
      ),
    );
    assert.ok(
      fakeDb.state.auditFindings.some(
        (finding) => finding.severity === FindingSeverity.WARNING,
      ),
    );
    assert.ok(
      fakeDb.state.auditFindings.some(
        (finding) => finding.severity === FindingSeverity.INFO,
      ),
    );

    const archive = await generateExport({
      storeId: store.id,
      exportType: ExportType.ARCHIVE_CSV,
    });
    assert.ok(
      archive.body.startsWith(
        "file,file_sha256,raw_storage_pointer,raw_byte_length,report_type,source_row,sku,normalized_json,raw_json,warnings",
      ),
    );
    assert.match(archive.body, /db:uploaded_file\.rawContentBase64:sha256:/);
    assert.match(archive.body, /stocky-po-proprietary-semicolon.csv/);
    assert.match(archive.body, /Internal Code #2/);

    const skuGap = await generateExport({
      storeId: store.id,
      exportType: ExportType.SKU_GAP_REPORT,
    });
    assert.ok(
      skuGap.body.startsWith(
        "severity,category,sku,title,message,recommended_action,created_at",
      ),
    );
    assert.match(skuGap.body, /UNMATCHED_SHOPIFY_SKU/);
    assert.match(skuGap.body, /LOCATION_MISMATCH/);

    const supplier = await generateExport({
      storeId: store.id,
      exportType: ExportType.SUPPLIER_RECONSTRUCTION_REPORT,
    });
    assert.ok(
      supplier.body.startsWith(
        "sku,title,supplier_hint,vendor_hint,source_file,source_row,stocky_reference,recommended_action",
      ),
    );
    assert.match(supplier.body, /SUP-REF-771/);
    assert.match(supplier.body, /TrailForge/);

    const checklist = await generateExport({
      storeId: store.id,
      exportType: ExportType.MIGRATION_CHECKLIST,
    });
    assert.ok(checklist.body.startsWith("item,status,evidence,next_action"));
    assert.match(checklist.body, /Upload Stocky CSV exports/);
    assert.match(
      checklist.body,
      /Historical Stocky purchase orders cannot be imported into Shopify/,
    );

    assert.equal(
      fakeDb.state.exportJobs.length,
      Object.values(ExportType).length,
    );
    assert.deepEqual(
      fakeDb.state.exportJobs.map((job) => job.status),
      Array.from(
        { length: Object.values(ExportType).length },
        () => ExportStatus.SUCCEEDED,
      ),
    );
  } finally {
    fakeDb.restore();
  }
});

function getNormalized(
  record: ReturnType<typeof parseStockyFixture>["records"][number],
  field: string,
) {
  const payload = record.normalizedPayload as {
    normalized?: Record<string, string | null>;
  };

  return payload.normalized?.[field];
}

function getRaw(
  record: ReturnType<typeof parseStockyFixture>["records"][number],
  field: string,
) {
  const payload = record.normalizedPayload as {
    raw?: Record<string, string>;
  };

  return payload.raw?.[field];
}

function getMeta(
  record: ReturnType<typeof parseStockyFixture>["records"][number],
) {
  const payload = record.normalizedPayload as {
    meta?: {
      duplicateHeaders?: string[];
    };
  };

  return payload.meta ?? {};
}

type StoreRow = {
  id: string;
  shop: string;
  installed: boolean;
  scopes: string | null;
  billingStatus: BillingStatus;
  createdAt: Date;
  updatedAt: Date;
  uninstalledAt: Date | null;
};

type UploadBatchRow = {
  id: string;
  storeId: string;
  status: UploadBatchStatus;
  fileCount: number;
  importedRowCount: number;
  warningCount: number;
  createdAt: Date;
  updatedAt: Date;
};

type UploadedFileRow = {
  id: string;
  batchId: string;
  originalFilename: string;
  detectedReportType: StockyReportType;
  parseStatus: FileParseStatus;
  storagePointer: string;
  contentSha256: string | null;
  rawContentBase64: string | null;
  rawContentByteLength: number | null;
  rowCount: number;
  warningCount: number;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type ParsedRecordRow = {
  id: string;
  uploadedFileId: string;
  normalizedType: StockyReportType;
  sourceRowNumber: number;
  sku: string | null;
  normalizedPayload: Prisma.JsonValue;
  warnings: Prisma.JsonValue | null;
  createdAt: Date;
};

type CatalogSnapshotRow = {
  id: string;
  storeId: string;
  syncStatus: SyncStatus;
  productCount: number;
  variantCount: number;
  inventoryItemCount: number;
  inventoryLevelCount: number;
  locationCount: number;
  summary: Prisma.JsonValue | null;
  errorMessage: string | null;
  syncedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type AuditFindingRow = {
  id: string;
  storeId: string;
  batchId: string | null;
  severity: FindingSeverity;
  category: FindingCategory;
  sku: string | null;
  title: string;
  message: string;
  recommendedAction: string;
  source: Prisma.JsonValue | null;
  resolvedAt: Date | null;
  createdAt: Date;
};

type ExportJobRow = {
  id: string;
  storeId: string;
  exportType: ExportType;
  status: ExportStatus;
  generatedFilePointer: string | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
};

type InMemoryState = {
  stores: StoreRow[];
  uploadBatches: UploadBatchRow[];
  uploadedFiles: UploadedFileRow[];
  parsedRecords: ParsedRecordRow[];
  catalogSnapshots: CatalogSnapshotRow[];
  auditFindings: AuditFindingRow[];
  exportJobs: ExportJobRow[];
};

type ParsedRecordWithFile = ParsedRecordRow & {
  uploadedFile: UploadedFileRow;
};

type UploadedFileWithRecords = UploadedFileRow & {
  parsedRecords: ParsedRecordRow[];
};

type UploadBatchWithFiles = UploadBatchRow & {
  uploadedFiles: UploadedFileWithRecords[];
};

type UploadBatchCreateArgs = {
  data: {
    storeId: string;
    status?: UploadBatchStatus;
    fileCount?: number;
  };
};

type UploadBatchUpdateArgs = {
  where: { id: string };
  data: Partial<
    Pick<
      UploadBatchRow,
      "status" | "importedRowCount" | "warningCount" | "fileCount"
    >
  >;
};

type UploadBatchFindUniqueArgs = {
  where: { id: string };
};

type UploadedFileCreateArgs = {
  data: {
    batchId: string;
    originalFilename: string;
    detectedReportType: StockyReportType;
    parseStatus: FileParseStatus;
    storagePointer: string;
    contentSha256?: string;
    rawContentBase64?: string | null;
    rawContentByteLength?: number | null;
    rowCount?: number;
    warningCount?: number;
    errorMessage?: string | null;
  };
};

type ParsedRecordCreateManyArgs = {
  data: Array<{
    uploadedFileId: string;
    normalizedType: StockyReportType;
    sourceRowNumber: number;
    sku: string | null;
    normalizedPayload: Prisma.InputJsonObject;
    warnings: Prisma.InputJsonArray;
  }>;
};

type ParsedRecordFindManyArgs = {
  where?: {
    uploadedFile?: {
      batch?: {
        storeId?: string;
      };
    };
  };
  orderBy?: Array<Record<string, "asc" | "desc">>;
  include?: {
    uploadedFile?: boolean;
  };
};

type ParsedRecordCountArgs = {
  where?: ParsedRecordFindManyArgs["where"];
};

type CatalogSnapshotFindFirstArgs = {
  where?: {
    storeId?: string;
    syncStatus?: SyncStatus;
  };
  orderBy?: {
    syncedAt?: "asc" | "desc";
    createdAt?: "asc" | "desc";
  };
};

type AuditFindingDeleteManyArgs = {
  where?: {
    storeId?: string;
    batchId?: string | null;
  };
};

type AuditFindingCreateManyArgs = {
  data: Array<{
    storeId: string;
    batchId?: string | null;
    severity: FindingSeverity;
    category: FindingCategory;
    sku: string | null;
    title: string;
    message: string;
    recommendedAction: string;
    source?: Prisma.InputJsonObject;
  }>;
};

type AuditFindingFindManyArgs = {
  where?: {
    storeId?: string;
    severity?: FindingSeverity;
    category?: FindingCategory | { in: FindingCategory[] };
  };
  orderBy?: Array<Record<string, "asc" | "desc">>;
};

type AuditFindingCountArgs = {
  where?: AuditFindingFindManyArgs["where"];
};

type ExportJobCreateArgs = {
  data: {
    storeId: string;
    exportType: ExportType;
    status: ExportStatus;
  };
};

type ExportJobUpdateArgs = {
  where: { id: string };
  data: Partial<
    Pick<
      ExportJobRow,
      "status" | "generatedFilePointer" | "errorMessage" | "completedAt"
    >
  >;
};

type RecordPayload = {
  raw?: Record<string, string>;
  normalized?: Record<string, string | null>;
  meta?: {
    duplicateHeaders?: string[];
    unknownColumns?: string[];
  };
};

function installInMemoryPrisma() {
  const state: InMemoryState = {
    stores: [],
    uploadBatches: [],
    uploadedFiles: [],
    parsedRecords: [],
    catalogSnapshots: [],
    auditFindings: [],
    exportJobs: [],
  };
  const mutableDb = db as unknown as Record<string, unknown>;
  const patchedKeys = [
    "store",
    "uploadBatch",
    "uploadedFile",
    "parsedRecord",
    "shopifyCatalogSnapshot",
    "auditFinding",
    "exportJob",
  ];
  const originals = new Map<string, unknown>(
    patchedKeys.map((key) => [key, mutableDb[key]]),
  );
  let sequence = 0;

  const nextId = (prefix: string) =>
    `${prefix}_${String((sequence += 1)).padStart(4, "0")}`;
  const now = () => new Date("2026-07-08T12:00:00.000Z");
  const createStore = (shop: string): StoreRow => {
    const store: StoreRow = {
      id: nextId("store"),
      shop,
      installed: true,
      scopes: "read_products,read_inventory,read_locations",
      billingStatus: BillingStatus.ACTIVE,
      createdAt: now(),
      updatedAt: now(),
      uninstalledAt: null,
    };

    state.stores.push(store);
    return store;
  };
  const seedCatalogSnapshot = ({
    storeId,
    summary,
  }: {
    storeId: string;
    summary: NonNullable<ReturnType<typeof readCatalogSummary>>;
  }) => {
    const snapshot: CatalogSnapshotRow = {
      id: nextId("snapshot"),
      storeId,
      syncStatus: SyncStatus.SUCCEEDED,
      productCount: new Set(
        summary.variants.map((variant) => variant.productId),
      ).size,
      variantCount: summary.variants.length,
      inventoryItemCount: new Set(
        summary.variants
          .map((variant) => variant.inventoryItemId)
          .filter((id): id is string => Boolean(id)),
      ).size,
      inventoryLevelCount: summary.variants.reduce(
        (sum, variant) => sum + variant.locations.length,
        0,
      ),
      locationCount: summary.locations.length,
      summary: JSON.parse(JSON.stringify(summary)) as Prisma.JsonValue,
      errorMessage: null,
      syncedAt: now(),
      createdAt: now(),
      updatedAt: now(),
    };

    state.catalogSnapshots.push(snapshot);
    return snapshot;
  };

  mutableDb.store = {};
  mutableDb.uploadBatch = {
    create: async ({ data }: UploadBatchCreateArgs) => {
      const batch: UploadBatchRow = {
        id: nextId("batch"),
        storeId: data.storeId,
        status: data.status ?? UploadBatchStatus.PENDING,
        fileCount: data.fileCount ?? 0,
        importedRowCount: 0,
        warningCount: 0,
        createdAt: now(),
        updatedAt: now(),
      };

      state.uploadBatches.push(batch);
      return batch;
    },
    update: async ({ where, data }: UploadBatchUpdateArgs) => {
      const batch = requireRow(state.uploadBatches, where.id, "UploadBatch");
      Object.assign(batch, data, { updatedAt: now() });
      return batch;
    },
    findUnique: async ({
      where,
    }: UploadBatchFindUniqueArgs): Promise<UploadBatchWithFiles | null> => {
      const batch = state.uploadBatches.find((row) => row.id === where.id);

      return batch ? withUploadedFiles(batch, state) : null;
    },
  };
  mutableDb.uploadedFile = {
    create: async ({ data }: UploadedFileCreateArgs) => {
      const file: UploadedFileRow = {
        id: nextId("file"),
        batchId: data.batchId,
        originalFilename: data.originalFilename,
        detectedReportType: data.detectedReportType,
        parseStatus: data.parseStatus,
        storagePointer: data.storagePointer,
        contentSha256: data.contentSha256 ?? null,
        rawContentBase64: data.rawContentBase64 ?? null,
        rawContentByteLength: data.rawContentByteLength ?? null,
        rowCount: data.rowCount ?? 0,
        warningCount: data.warningCount ?? 0,
        errorMessage: data.errorMessage ?? null,
        createdAt: now(),
        updatedAt: now(),
      };

      state.uploadedFiles.push(file);
      return file;
    },
  };
  mutableDb.parsedRecord = {
    createMany: async ({ data }: ParsedRecordCreateManyArgs) => {
      for (const item of data) {
        state.parsedRecords.push({
          id: nextId("record"),
          uploadedFileId: item.uploadedFileId,
          normalizedType: item.normalizedType,
          sourceRowNumber: item.sourceRowNumber,
          sku: item.sku,
          normalizedPayload: item.normalizedPayload as Prisma.JsonValue,
          warnings: item.warnings as Prisma.JsonValue,
          createdAt: now(),
        });
      }

      return { count: data.length };
    },
    findMany: async (
      args: ParsedRecordFindManyArgs = {},
    ): Promise<Array<ParsedRecordRow | ParsedRecordWithFile>> => {
      const storeId = args.where?.uploadedFile?.batch?.storeId;
      let rows = storeId
        ? state.parsedRecords.filter((record) =>
            recordBelongsToStore(record, storeId, state),
          )
        : [...state.parsedRecords];
      rows = sortRows(rows, args.orderBy);

      if (!args.include?.uploadedFile) {
        return rows;
      }

      return rows.map((record) => ({
        ...record,
        uploadedFile: requireRow(
          state.uploadedFiles,
          record.uploadedFileId,
          "UploadedFile",
        ),
      }));
    },
    count: async (args: ParsedRecordCountArgs = {}) => {
      const storeId = args.where?.uploadedFile?.batch?.storeId;

      return storeId
        ? state.parsedRecords.filter((record) =>
            recordBelongsToStore(record, storeId, state),
          ).length
        : state.parsedRecords.length;
    },
  };
  mutableDb.shopifyCatalogSnapshot = {
    findFirst: async (args: CatalogSnapshotFindFirstArgs = {}) => {
      let rows = state.catalogSnapshots.filter((snapshot) => {
        if (args.where?.storeId && snapshot.storeId !== args.where.storeId) {
          return false;
        }

        return !(
          args.where?.syncStatus &&
          snapshot.syncStatus !== args.where.syncStatus
        );
      });

      rows = sortRows(rows, args.orderBy ? [args.orderBy] : undefined);
      return rows[0] ?? null;
    },
  };
  mutableDb.auditFinding = {
    deleteMany: async (args: AuditFindingDeleteManyArgs = {}) => {
      const before = state.auditFindings.length;
      state.auditFindings = state.auditFindings.filter(
        (finding) => !matchesAuditFindingWhere(finding, args.where),
      );

      return { count: before - state.auditFindings.length };
    },
    createMany: async ({ data }: AuditFindingCreateManyArgs) => {
      for (const item of data) {
        state.auditFindings.push({
          id: nextId("finding"),
          storeId: item.storeId,
          batchId: item.batchId ?? null,
          severity: item.severity,
          category: item.category,
          sku: item.sku,
          title: item.title,
          message: item.message,
          recommendedAction: item.recommendedAction,
          source: (item.source ?? null) as Prisma.JsonValue | null,
          resolvedAt: null,
          createdAt: now(),
        });
      }

      return { count: data.length };
    },
    findMany: async (args: AuditFindingFindManyArgs = {}) =>
      sortRows(
        state.auditFindings.filter((finding) =>
          matchesAuditFindingWhere(finding, args.where),
        ),
        args.orderBy,
      ),
    count: async (args: AuditFindingCountArgs = {}) =>
      state.auditFindings.filter((finding) =>
        matchesAuditFindingWhere(finding, args.where),
      ).length,
  };
  mutableDb.exportJob = {
    create: async ({ data }: ExportJobCreateArgs) => {
      const job: ExportJobRow = {
        id: nextId("export"),
        storeId: data.storeId,
        exportType: data.exportType,
        status: data.status,
        generatedFilePointer: null,
        errorMessage: null,
        createdAt: now(),
        updatedAt: now(),
        completedAt: null,
      };

      state.exportJobs.push(job);
      return job;
    },
    update: async ({ where, data }: ExportJobUpdateArgs) => {
      const job = requireRow(state.exportJobs, where.id, "ExportJob");
      Object.assign(job, data, { updatedAt: now() });
      return job;
    },
  };

  return {
    state,
    createStore,
    seedCatalogSnapshot,
    restore() {
      for (const [key, value] of originals.entries()) {
        mutableDb[key] = value;
      }
    },
  };
}

function withUploadedFiles(
  batch: UploadBatchRow,
  state: InMemoryState,
): UploadBatchWithFiles {
  return {
    ...batch,
    uploadedFiles: state.uploadedFiles
      .filter((file) => file.batchId === batch.id)
      .map((file) => ({
        ...file,
        parsedRecords: state.parsedRecords.filter(
          (record) => record.uploadedFileId === file.id,
        ),
      })),
  };
}

function requireRow<T extends { id: string }>(
  rows: T[],
  id: string,
  modelName: string,
) {
  const row = rows.find((candidate) => candidate.id === id);

  if (!row) {
    throw new Error(`${modelName} ${id} was not found in the in-memory DB.`);
  }

  return row;
}

function recordBelongsToStore(
  record: ParsedRecordRow,
  storeId: string,
  state: InMemoryState,
) {
  const file = state.uploadedFiles.find(
    (candidate) => candidate.id === record.uploadedFileId,
  );
  const batch = file
    ? state.uploadBatches.find((candidate) => candidate.id === file.batchId)
    : null;

  return batch?.storeId === storeId;
}

function matchesAuditFindingWhere(
  finding: AuditFindingRow,
  where:
    AuditFindingFindManyArgs["where"] | AuditFindingDeleteManyArgs["where"],
) {
  if (!where) {
    return true;
  }

  if (where.storeId && finding.storeId !== where.storeId) {
    return false;
  }

  if ("batchId" in where && finding.batchId !== where.batchId) {
    return false;
  }

  if (
    "severity" in where &&
    where.severity &&
    finding.severity !== where.severity
  ) {
    return false;
  }

  if ("category" in where && where.category) {
    if (typeof where.category === "object") {
      return where.category.in.includes(finding.category);
    }

    return finding.category === where.category;
  }

  return true;
}

function sortRows<T extends Record<string, unknown>>(
  rows: T[],
  orderBy?: Array<Record<string, "asc" | "desc">>,
) {
  if (!orderBy?.length) {
    return [...rows];
  }

  return [...rows].sort((left, right) => {
    for (const order of orderBy) {
      const [field, direction] = Object.entries(order)[0] ?? [];

      if (!field || !direction) {
        continue;
      }

      const comparison = compareValues(left[field], right[field]);

      if (comparison !== 0) {
        return direction === "desc" ? -comparison : comparison;
      }
    }

    return 0;
  });
}

function compareValues(left: unknown, right: unknown) {
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() - right.getTime();
  }

  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }

  return String(left ?? "").localeCompare(String(right ?? ""));
}

function readRecordPayload(record: ParsedRecordRow): RecordPayload {
  if (
    !record.normalizedPayload ||
    typeof record.normalizedPayload !== "object" ||
    Array.isArray(record.normalizedPayload)
  ) {
    return {};
  }

  return record.normalizedPayload as RecordPayload;
}
