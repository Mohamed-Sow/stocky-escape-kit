import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { unzipSync } from "fflate";
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
import {
  CatalogSyncLimitError,
  fetchCatalogVariants,
  readCatalogSummary,
} from "../app/lib/catalog.server";
import { parseCsv, toCsv } from "../app/lib/csv.server";
import { generateExport } from "../app/lib/exports.server";
import { generateOpenPurchaseOrderImportPackage } from "../app/lib/open-po-import.server";
import {
  formatRunFilenameStamp,
  getExportFilename,
  getOpenPurchaseOrderImportFilename,
  getReviewKitFilename,
} from "../app/lib/export-filenames";
import {
  resolveFindingsPage,
  resolveRunHistoryPage,
} from "../app/lib/pagination";
import { generateReviewKit } from "../app/lib/review-kit.server";
import { generateReviewerFixturePack } from "../app/lib/review-fixtures.server";
import {
  attachmentContentDisposition,
  safeDownloadFilename,
} from "../app/lib/filenames.server";
import {
  canGenerateExport,
  getPlanEntitlements,
  resolveBillingAccess,
  resolveBillingTier,
  validateUploadFiles,
} from "../app/lib/entitlements.server";
import {
  DELETE_RUN_CONFIRMATION,
  RESET_CONFIRMATION,
  deleteStoreMigrationRun,
  resetStoreMigrationData,
} from "../app/lib/reset.server";
import {
  RequestSizeLimitError,
  readFormDataWithinLimit,
} from "../app/lib/request-size.server";
import { runHostedSmokeProof } from "../app/lib/shopify-smoke.server";
import { getSupportEmail } from "../app/lib/support.server";
import {
  BILLING_PLAN_DETAILS,
  BILLING_PLAN_NAMES,
  PRIVATE_TEST_BILLING_DISPLAY_NAME,
  PRIVATE_TEST_BILLING_PLAN,
  getPlanSelectionUrl,
  getActiveBillingName,
  getPartnerBillingEvidence,
  hasActiveBillingSubscription,
  isBillingTestMode,
  isValidBillingPlan,
  type PartnerBillingCheck,
} from "../app/models/billing.server";
import {
  getUploadedFiles,
  importStockyCsvFiles,
} from "../app/lib/uploads.server";
import { resolveStockySourceCoverage } from "../app/lib/source-coverage";
import { decodeStockyCsvBytes } from "../app/lib/text-decoding.server";
import {
  normalizeHeader,
  parseStockyCsv,
  reportRequiresSku,
} from "../app/lib/stocky-parser.server";
import {
  parseStockyDecimal,
  parseStockyInteger,
} from "../app/lib/stocky-numbers";
import {
  findDuplicatePurchaseOrderLineIndexes,
  isOpenPurchaseOrderStatus,
  recoverOpenPurchaseOrderEvidence,
  resolveOpenPurchaseOrderQuantity,
} from "../app/lib/open-purchase-orders";
import { getSafeRequestPath } from "../server/request-logging.mjs";

const STOCKY_FIXTURE_DIR = path.join(process.cwd(), "fixtures", "stocky");

test("production request logs omit Shopify query credentials", () => {
  assert.equal(
    getSafeRequestPath(
      "/app?embedded=1&host=c2hvcGlmeS5jb20&hmac=secret&id_token=short-lived-token&shop=example.myshopify.com",
    ),
    "/app",
  );

  const packageJson = JSON.parse(
    readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
  ) as { scripts: { start: string } };
  assert.equal(packageJson.scripts.start, "node ./server/index.mjs");
  assert.match(
    readFileSync(path.join(process.cwd(), "Dockerfile"), "utf8"),
    /COPY --from=build \/app\/server \.\/server/,
  );
});

test("migration run history pages remain bounded and reachable", () => {
  assert.deepEqual(resolveRunHistoryPage(null, 0), {
    page: 1,
    pageCount: 1,
    pageSize: 25,
    skip: 0,
    total: 0,
  });
  assert.equal(resolveRunHistoryPage("2", 75).skip, 25);
  assert.equal(resolveRunHistoryPage("99", 75).page, 3);
  assert.equal(resolveRunHistoryPage("invalid", 75).page, 1);
});

test("finding result pages remain bounded and reachable", () => {
  assert.deepEqual(resolveFindingsPage(null, 0), {
    page: 1,
    pageCount: 1,
    pageSize: 25,
    skip: 0,
    total: 0,
  });
  assert.equal(resolveFindingsPage("2", 250).skip, 25);
  assert.equal(resolveFindingsPage("99", 250).page, 10);
  assert.equal(resolveFindingsPage("invalid", 250).page, 1);
});

test("catalog sync busy state is scoped to its own submission", () => {
  const dashboardRoute = readFileSync(
    path.join(process.cwd(), "app", "routes", "app._index.tsx"),
    "utf8",
  );

  assert.match(
    dashboardRoute,
    /navigation\.formData\?\.get\("intent"\) === "sync_catalog"/,
  );
  assert.match(
    dashboardRoute,
    /navigation\.formData\?\.get\("batchId"\) === batchId/,
  );
});

test("merchant-facing workflow labels stay truthful and task-oriented", () => {
  const dashboardRoute = readFileSync(
    path.join(process.cwd(), "app", "routes", "app._index.tsx"),
    "utf8",
  );
  const auditGenerator = readFileSync(
    path.join(process.cwd(), "app", "lib", "audit.server.ts"),
    "utf8",
  );

  assert.match(dashboardRoute, /IMPORTED: "Preserved"/);
  assert.match(dashboardRoute, /label="Rows parsed"/);
  assert.doesNotMatch(dashboardRoute, /label="Rows imported"/);
  assert.match(dashboardRoute, /Download the complete migration package/);
  assert.match(dashboardRoute, /Download open PO files/);
  assert.match(
    dashboardRoute,
    /official-format Shopify import CSV per open Stocky\s+PO/,
  );
  assert.match(dashboardRoute, /Generic Stocky Tax\s+columns are left blank/);
  assert.doesNotMatch(dashboardRoute, /Download the complete review kit/);
  assert.match(dashboardRoute, /Before August 31, 2026/);
  assert.match(dashboardRoute, /role="note"/);
  assert.match(dashboardRoute, /aria-label={`Selected run coverage:/);
  assert.match(dashboardRoute, /Combined file size per run/);
  assert.match(dashboardRoute, /view === "settings" \? null :/);
  assert.match(dashboardRoute, /cta: "Review critical findings"/);
  assert.match(dashboardRoute, /findingSeverity: "CRITICAL"/);
  assert.doesNotMatch(dashboardRoute, />\s*Continue\s*</);
  assert.match(
    dashboardRoute,
    /formatBytes\(data\.entitlements\.maxFileBytes\)} per file/,
  );
  assert.ok(
    dashboardRoute.indexOf("Selected run") <
      dashboardRoute.indexOf("<FileStager"),
    "selected run files should appear before the new-run uploader",
  );
  assert.ok(
    dashboardRoute.indexOf("<FileStager") <
      dashboardRoute.indexOf("Before August 31, 2026"),
    "the operational file workflow should appear before background guidance",
  );
  assert.doesNotMatch(dashboardRoute, /rows imported/);
  assert.doesNotMatch(auditGenerator, /app reviewer/i);
  assert.doesNotMatch(auditGenerator, /before importing/i);
});

test("source coverage requires every core successfully parsed Stocky report", () => {
  const partial = resolveStockySourceCoverage([
    { reportType: "PRODUCTS", status: "PARSED" },
    { reportType: "PURCHASE_ORDERS", status: "FAILED" },
    { reportType: "VENDORS", status: "PARSED" },
  ]);
  const complete = resolveStockySourceCoverage(
    ["PURCHASE_ORDERS", "STOCKTAKES", "HISTORICAL_COSTS"].map((reportType) => ({
      reportType,
      status: "PARSED",
    })),
  );

  assert.equal(partial.coreTypesRepresented, false);
  assert.deepEqual(partial.covered, []);
  assert.deepEqual(partial.supplementalCovered, ["PRODUCTS", "VENDORS"]);
  assert.ok(partial.missing.includes("PURCHASE_ORDERS"));
  assert.equal(complete.coreTypesRepresented, true);
  assert.equal(complete.covered.length, complete.total);
});

test("export filenames identify the selected migration run", () => {
  const createdAt = new Date("2026-07-10T15:36:04.123Z");

  assert.equal(formatRunFilenameStamp(createdAt), "20260710T153604123Z");
  assert.equal(
    getExportFilename(ExportType.SKU_GAP_REPORT, createdAt),
    "stocky-audit-findings-run-20260710T153604123Z.csv",
  );
  assert.equal(
    getReviewKitFilename(createdAt),
    "stocky-migration-package-run-20260710T153604123Z.zip",
  );
});

test("public reviewer fixture pack contains exactly the ten canonical CSVs", async () => {
  const archive = unzipSync(await generateReviewerFixturePack());
  const filenames = Object.keys(archive).sort();

  assert.equal(
    filenames.filter((filename) => filename.endsWith(".csv")).length,
    10,
  );
  assert.ok(filenames.includes("README.txt"));
  assert.ok(filenames.includes("stocky-malformed-unclosed-quote.csv"));
  assert.ok(filenames.includes("stocky-products-edge-cases.csv"));
  assert.match(new TextDecoder().decode(archive["README.txt"]), /32 warnings/);
  assert.match(
    readFileSync(path.join(process.cwd(), "Dockerfile"), "utf8"),
    /COPY --from=build \/app\/fixtures\/stocky \.\/fixtures\/stocky/,
  );
});

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
      [" safe", '  =HYPERLINK("https://example.com")', "\t=1+1", "plain"],
    ]),
    [
      "sku,supplier,quantity,note",
      "'=cmd|' /C calc'!A0,\"'+SUM(1,2)\",'-2,'@hidden",
      ' safe,"\'  =HYPERLINK(""https://example.com"")",\'\t=1+1,plain',
    ].join("\n"),
  );
});

test("download filenames cannot escape quoted headers or archive paths", () => {
  assert.equal(
    safeDownloadFilename('..\\bad/"name\r\n.csv'),
    ".._bad__name__.csv",
  );
});

test("download headers keep Unicode filenames in an encoded parameter", () => {
  assert.equal(
    attachmentContentDisposition("Stocky café.csv"),
    "attachment; filename=\"Stocky caf_.csv\"; filename*=UTF-8''Stocky%20caf%C3%A9.csv",
  );
});

test("CSV parser accepts semicolon and tab-delimited exports", () => {
  assert.deepEqual(parseCsv('SKU;Notes;Optional\nABC;"contains; delimiter";'), {
    headers: ["SKU", "Notes", "Optional"],
    rows: [
      {
        sourceRowNumber: 2,
        values: ["ABC", "contains; delimiter", ""],
      },
    ],
    errors: [],
  });

  assert.deepEqual(parseCsv("SKU\tQty\tOptional\nABC\t12\t"), {
    headers: ["SKU", "Qty", "Optional"],
    rows: [
      {
        sourceRowNumber: 2,
        values: ["ABC", "12", ""],
      },
    ],
    errors: [],
  });
});

test("CSV parser keeps physical source row numbers across blank and quoted lines", () => {
  const csv = parseCsv('SKU,Notes\n\nABC,"first\nsecond"\n\nDEF,plain\n');

  assert.deepEqual(
    csv.rows.map((row) => ({
      sourceRowNumber: row.sourceRowNumber,
      sku: row.values[0],
    })),
    [
      { sourceRowNumber: 3, sku: "ABC" },
      { sourceRowNumber: 6, sku: "DEF" },
    ],
  );
});

test("Stocky CSV byte decoding preserves UTF-16 and Windows-1252 exports", () => {
  const utf16le = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from("SKU,Title\nUTF16-1,Café\n", "utf16le"),
  ]);
  const windows1252 = Buffer.concat([
    Buffer.from("SKU,Title\nWIN-1,Caf", "ascii"),
    Buffer.from([0xe9]),
    Buffer.from("\n", "ascii"),
  ]);

  assert.deepEqual(decodeStockyCsvBytes(utf16le), {
    content: "SKU,Title\nUTF16-1,Café\n",
    encoding: "utf-16le",
  });
  assert.deepEqual(decodeStockyCsvBytes(windows1252), {
    content: "SKU,Title\nWIN-1,Café\n",
    encoding: "windows-1252",
  });
});

test("Stocky parser rejects empty bytes but accepts a real header-only export", () => {
  const empty = parseStockyCsv({
    filename: "empty.csv",
    content: " \r\n\t",
  });
  const headerOnly = parseStockyCsv({
    filename: "header-only.csv",
    content: "SKU,Title,Vendor\n",
  });

  assert.deepEqual(empty.parseErrors, ["CSV does not contain a header row."]);
  assert.deepEqual(headerOnly.parseErrors, []);
  assert.equal(headerOnly.rowCount, 0);
});

test("Stocky parser flags malformed cost, quantity, and date evidence", () => {
  const parsed = parseStockyCsv({
    filename: "stocky-products.csv",
    content: "SKU,Unit Cost,Qty,Date\nBAD-VALUES,not-money,twelve,2026-99-99",
  });

  assert.deepEqual(parsed.records[0].warnings, [
    "invalid_cost",
    "invalid_quantity",
    "invalid_date",
  ]);
});

test("Stocky parser does not treat an unlabeled Tax column as a percentage", () => {
  const parsed = parseStockyCsv({
    filename: "open-purchase-orders.csv",
    content: "PO Number,Status,SKU,Qty Ordered,Tax\nPO-1,Open,SKU-1,4,12.50",
  });
  const normalized = parsed.records[0].normalizedPayload.normalized as {
    taxRate?: string | null;
  };

  assert.equal(normalized.taxRate, null);
  assert.ok(parsed.unknownColumns.includes("Tax"));
  assert.ok(parsed.records[0].warnings.includes("ambiguous_tax"));
});

test("Stocky numeric normalization fails closed on ambiguous money and resolves whole quantities", () => {
  assert.equal(parseStockyDecimal("12,50"), 12.5);
  assert.equal(parseStockyDecimal("1.234,56"), 1234.56);
  assert.equal(parseStockyDecimal("1,234.56"), 1234.56);
  assert.equal(parseStockyDecimal("1,234"), null);
  assert.equal(parseStockyInteger("1,234"), 1234);
  assert.equal(parseStockyInteger("12.5"), null);
});

test("open purchase-order quantities never guess a partial remaining balance", () => {
  assert.deepEqual(
    resolveOpenPurchaseOrderQuantity({
      status: "Partially Received",
      quantityOrdered: "12",
      quantityReceived: "5",
    }),
    {
      quantity: 7,
      basis: "ordered_minus_received",
      reason: "Calculated ordered quantity minus received quantity.",
    },
  );
  assert.equal(
    resolveOpenPurchaseOrderQuantity({
      status: "Partially Received",
      quantity: "12",
    }).quantity,
    null,
  );
  assert.equal(
    resolveOpenPurchaseOrderQuantity({
      status: "Not received",
      quantity: "12",
    }).quantity,
    12,
  );
});

test("closed purchase-order statuses never enter the open-work handoff", () => {
  assert.equal(isOpenPurchaseOrderStatus("Partially Received"), true);
  assert.equal(isOpenPurchaseOrderStatus("Received in Part"), true);
  assert.equal(
    isOpenPurchaseOrderStatus("Partially Received and Closed"),
    false,
  );
  assert.equal(isOpenPurchaseOrderStatus("Fully Received"), false);
  assert.equal(isOpenPurchaseOrderStatus("Completed"), false);
  assert.equal(isOpenPurchaseOrderStatus("Canceled"), false);
  assert.equal(isOpenPurchaseOrderStatus("Void"), false);
  assert.equal(isOpenPurchaseOrderStatus("Rejected"), false);
});

test("purchase-order duplicate detection checks both SKU and barcode identity", () => {
  assert.deepEqual(
    [
      ...findDuplicatePurchaseOrderLineIndexes([
        { sku: "SKU-1", barcode: "BAR-1" },
        { sku: "SKU-2", barcode: "BAR-1" },
        { sku: "SKU-1", barcode: "BAR-3" },
        { sku: "SKU-4", barcode: "BAR-4" },
      ]),
    ].sort((left, right) => left - right),
    [0, 1, 2],
  );
});

test("open purchase-order handoff recovers fields from previously parsed raw rows", () => {
  const recovered = recoverOpenPurchaseOrderEvidence({
    raw: {
      "P.O. Number": "PO-LEGACY",
      "Line Status": "Partially Received",
      "Stock Code": "SKU-LEGACY",
      "Supplier Ref #": "SUP-LEGACY",
      "Qty Ordered": "12",
      "Qty Received": "5",
      "Cost (base)": "12,50",
      Tax: "12.50",
    },
    normalized: {
      sku: "SKU-LEGACY",
      supplier: "SUP-LEGACY",
      quantity: "12",
      taxRate: "12.50",
      status: "Partially Received",
      reference: "PO-LEGACY",
    },
  });

  assert.equal(recovered.sku, "SKU-LEGACY");
  assert.equal(recovered.supplierSku, "SUP-LEGACY");
  assert.equal(recovered.supplier, null);
  assert.equal(recovered.quantityOrdered, "12");
  assert.equal(recovered.quantityReceived, "5");
  assert.equal(recovered.cost, "12,50");
  assert.equal(recovered.taxRate, null);
  assert.equal(resolveOpenPurchaseOrderQuantity(recovered).quantity, 7);

  assert.equal(
    recoverOpenPurchaseOrderEvidence({
      raw: { "Tax %": "6.5" },
      normalized: { taxRate: "6.5" },
    }).taxRate,
    "6.5",
  );
});

test("Stocky parser recognizes current documented Stocky report shapes", () => {
  const stocktake = parseStockyCsv({
    filename: "stocktake.csv",
    content:
      "Product Name,SKU,Barcode,Shopify ID,Retail Price,Cost Price,Expected Stock,Actual Stock,Adjustment Total,Adjustment Cost\nWidget,SKU-1,12345,98765,20.00,8.00,10,9,-1,-8.00",
  });
  const historicalStock = parseStockyCsv({
    filename: "historical-stock-on-hand.csv",
    content:
      "Date,Total Cost,Total Retail,Total Items\n2026-07-01,100.00,250.00,12",
  });
  const adjustments = parseStockyCsv({
    filename: "stocky-adjustments.csv",
    content:
      "Date,Reason,Employee,SKU,Adjustment Total\n2026-07-01,Cycle count,Alex,SKU-1,-1",
  });
  const transfers = parseStockyCsv({
    filename: "stocky-transfers.csv",
    content:
      "Transfer Number,Status,Origin,Destination,Reason,SKU,Quantity\nTR-1,Complete,Warehouse,Shop floor,Replenishment,SKU-1,4",
  });
  const purchaseOrder = parseStockyCsv({
    filename: "po_1848.csv",
    content:
      "SKU,Qty Ordered,Cost (base),Total Cost (base)\nABC123,10,15.00,150.00",
  });
  const currentStock = parseStockyCsv({
    filename: "current-stock-on-hand.csv",
    content: "SKU,Product Name,Cost Price,Stock on Hand\nSKU-1,Widget,8.00,9",
  });
  const currentProductCosts = parseStockyCsv({
    filename: "product-costs.csv",
    content: "SKU,Product Name,Unit Cost\nSKU-1,Widget,8.00",
  });

  assert.equal(stocktake.reportType, StockyReportType.STOCKTAKES);
  assert.deepEqual(stocktake.unknownColumns, []);
  assert.deepEqual(stocktake.records[0].warnings, []);

  assert.equal(historicalStock.reportType, StockyReportType.HISTORICAL_COSTS);
  assert.equal(reportRequiresSku(historicalStock.reportType), false);
  assert.deepEqual(historicalStock.unknownColumns, []);
  assert.deepEqual(historicalStock.records[0].warnings, []);

  assert.equal(adjustments.reportType, StockyReportType.INVENTORY_ACTIVITY);
  assert.deepEqual(adjustments.unknownColumns, []);
  assert.deepEqual(adjustments.records[0].warnings, []);

  assert.equal(transfers.reportType, StockyReportType.INVENTORY_ACTIVITY);
  assert.deepEqual(transfers.unknownColumns, []);
  assert.deepEqual(transfers.records[0].warnings, []);

  assert.equal(purchaseOrder.reportType, StockyReportType.PURCHASE_ORDERS);
  assert.deepEqual(purchaseOrder.unknownColumns, []);
  assert.deepEqual(purchaseOrder.records[0].warnings, []);
  assert.equal(
    (
      purchaseOrder.records[0].normalizedPayload.normalized as {
        totalCost?: string;
      }
    ).totalCost,
    "150.00",
  );

  assert.equal(currentStock.reportType, StockyReportType.PRODUCTS);
  assert.equal(currentProductCosts.reportType, StockyReportType.PRODUCTS);
});

test("duplicate normalized headers preserve every value and use the first nonblank match", () => {
  const parsed = parseStockyCsv({
    filename: "stocky-products.csv",
    content: "SKU,sku,Title\n,SECOND-SKU,Duplicate header product",
  });

  assert.equal(parsed.records[0].sku, "SECOND-SKU");
  assert.deepEqual(
    (
      parsed.records[0].normalizedPayload.meta as {
        duplicateHeaders?: string[];
      }
    ).duplicateHeaders,
    ["SKU"],
  );
  assert.equal(parsed.warningCount, 1);
});

test("supplier SKUs remain distinct from Shopify variant SKUs", () => {
  const parsed = parseStockyCsv({
    filename: "supplier-custom-sku-report.csv",
    content: "Supplier SKU,Supplier Name,Product Name\nSUP-1,Acme,Widget",
  });

  assert.equal(parsed.reportType, StockyReportType.VENDORS);
  assert.equal(parsed.records[0].sku, null);
  assert.equal(
    (
      parsed.records[0].normalizedPayload.normalized as {
        supplierSku?: string;
      }
    ).supplierSku,
    "SUP-1",
  );
});

test("purchase-order quantities preserve ordered, received, and remaining evidence", () => {
  const parsed = parseStockyCsv({
    filename: "purchase-orders.csv",
    content:
      "PO Number,Status,SKU,Supplier SKU,Qty Ordered,Qty Received,Qty Remaining,Tax %\nPO-1,Partially Received,SKU-1,SUP-1,12,5,7,6.5",
  });
  const normalized = parsed.records[0].normalizedPayload.normalized as {
    sku?: string;
    supplierSku?: string;
    quantity?: string;
    quantityOrdered?: string;
    quantityReceived?: string;
    quantityOutstanding?: string;
    taxRate?: string;
  };

  assert.equal(parsed.records[0].sku, "SKU-1");
  assert.deepEqual(normalized, {
    sku: "SKU-1",
    supplierSku: "SUP-1",
    title: null,
    barcode: null,
    shopifyId: null,
    vendor: null,
    supplier: null,
    location: null,
    cost: null,
    totalCost: null,
    retailValue: null,
    adjustmentCost: null,
    quantity: "12",
    quantityOrdered: "12",
    quantityReceived: "5",
    quantityOutstanding: "7",
    taxRate: "6.5",
    status: "Partially Received",
    date: null,
    reference: "PO-1",
    reason: null,
    employee: null,
  });
  assert.deepEqual(parsed.records[0].warnings, []);
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
    supplierSku: null,
    title: "Widget",
    barcode: "12345",
    shopifyId: null,
    vendor: "Acme",
    supplier: null,
    location: null,
    cost: null,
    totalCost: null,
    retailValue: null,
    adjustmentCost: null,
    quantity: null,
    quantityOrdered: null,
    quantityReceived: null,
    quantityOutstanding: null,
    taxRate: null,
    status: null,
    date: null,
    reference: null,
    reason: null,
    employee: null,
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

test("supplier-only and unclassified evidence do not create false missing SKU warnings", () => {
  const suppliers = parseStockyCsv({
    filename: "stocky-vendors.csv",
    content: "Supplier Name,Phone\nAcme,555-0100",
  });
  const unknown = parseStockyCsv({
    filename: "notes.csv",
    content: "Export Label,Freeform Value\nReminder,Keep this",
  });

  assert.equal(suppliers.reportType, StockyReportType.VENDORS);
  assert.equal(unknown.reportType, StockyReportType.UNKNOWN);
  assert.equal(reportRequiresSku(suppliers.reportType), false);
  assert.equal(reportRequiresSku(unknown.reportType), false);
  assert.deepEqual(suppliers.records[0].warnings, []);
  assert.deepEqual(unknown.records[0].warnings, []);
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

test("catalog variant sync paginates every page and omits incomplete nested inventory levels", async () => {
  const cursors: Array<string | null> = [];
  const queries: string[] = [];
  const pages = [
    {
      data: {
        productVariants: {
          pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
          edges: [catalogVariantEdge("1", "SKU-1")],
        },
      },
    },
    {
      data: {
        productVariants: {
          pageInfo: { hasNextPage: false, endCursor: "cursor-2" },
          edges: [catalogVariantEdge("2", "SKU-2")],
        },
      },
    },
  ];
  const admin = {
    graphql: async (
      query: string,
      options?: { variables?: Record<string, unknown> },
    ) => {
      queries.push(query);
      cursors.push((options?.variables?.cursor as string | null) ?? null);
      const page = pages[cursors.length - 1];
      return new Response(JSON.stringify(page), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  };

  const variants = await fetchCatalogVariants({ admin, limit: 10 });

  assert.deepEqual(cursors, [null, "cursor-1"]);
  assert.deepEqual(
    variants.map((variant) => variant.sku),
    ["SKU-1", "SKU-2"],
  );
  assert.equal(
    queries.every((query) => !query.includes("inventoryLevels")),
    true,
  );
  assert.equal(
    variants.every((variant) => variant.locations.length === 0),
    true,
  );
});

test("catalog variant sync fails closed instead of auditing a partial catalog", async () => {
  const admin = {
    graphql: async () =>
      new Response(
        JSON.stringify({
          data: {
            productVariants: {
              pageInfo: { hasNextPage: false, endCursor: "cursor-2" },
              edges: [
                catalogVariantEdge("1", "SKU-1"),
                catalogVariantEdge("2", "SKU-2"),
              ],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  };

  await assert.rejects(
    fetchCatalogVariants({ admin, limit: 1 }),
    CatalogSyncLimitError,
  );
});

test("billing helpers validate configured App Pricing subscription names", () => {
  assert.equal(BILLING_PLAN_NAMES.length, 8);
  assert.equal(isValidBillingPlan("Stocky Pro"), true);
  assert.equal(isValidBillingPlan("Stocky Escape Kit Pro"), true);
  assert.equal(isValidBillingPlan(PRIVATE_TEST_BILLING_PLAN), true);
  assert.equal(isValidBillingPlan(PRIVATE_TEST_BILLING_DISPLAY_NAME), true);
  assert.equal(isValidBillingPlan("Other Plan"), false);

  const activeCheck: PartnerBillingCheck = {
    active: true,
    shop: "stocky-escape-kit-partner-dev.myshopify.com",
    shopId: "gid://shopify/Shop/1",
    source: "Partner API activeSubscription",
    missingEnv: [],
    errors: [],
    subscription: {
      billingPeriod: "EVERY_30_DAYS",
      cancelAtEndOfCycle: false,
      trialEndsAt: null,
      currentBillingCycle: {
        startTime: "2026-07-01T00:00:00Z",
        endTime: "2026-08-01T00:00:00Z",
      },
      legacySubscriptionId: null,
      items: [
        {
          handle: "localized-review-plan",
          description: "Localized private review plan",
          price: {
            type: "FlatRatePrice",
            active: true,
            currency: "USD",
            amount: "0.00",
            tiersMode: null,
            tiers: [],
          },
        },
      ],
    },
  };

  assert.equal(hasActiveBillingSubscription(activeCheck), true);
  assert.equal(
    getActiveBillingName(activeCheck),
    "Localized private review plan",
  );
  assert.deepEqual(getPartnerBillingEvidence(activeCheck), [
    {
      handle: "localized-review-plan",
      description: "Localized private review plan",
      price: "0.00 USD",
    },
  ]);
  assert.equal(
    getActiveBillingName({
      ...activeCheck,
      subscription: {
        ...activeCheck.subscription!,
        items: [
          {
            ...activeCheck.subscription!.items[0],
            handle: PRIVATE_TEST_BILLING_PLAN,
            description: "Shopify Test",
          },
        ],
      },
    }),
    PRIVATE_TEST_BILLING_DISPLAY_NAME,
  );
  assert.equal(
    hasActiveBillingSubscription({
      ...activeCheck,
      active: false,
      subscription: null,
      errors: [
        "Partner API returned no active Shopify App Pricing subscription.",
      ],
    }),
    false,
  );
  assert.equal(
    getActiveBillingName({
      ...activeCheck,
      active: false,
      subscription: null,
      errors: [
        "Partner API returned no active Shopify App Pricing subscription.",
      ],
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

test("merchant plan summaries state both per-file and combined run limits", () => {
  const mib = 1024 * 1024;

  for (const plan of BILLING_PLAN_DETAILS) {
    const entitlements = getPlanEntitlements(plan.id);

    assert.match(
      plan.summary,
      new RegExp(`${entitlements.maxFileBytes / mib} MB per file`),
    );
    assert.match(
      plan.summary,
      new RegExp(`${entitlements.maxBatchBytes / mib} MB combined`),
    );
    assert.match(
      plan.summary,
      new RegExp(
        `${entitlements.maxRowsPerBatch.toLocaleString()} parsed rows per run`,
      ),
    );
  }
});

test("plan entitlements are enforced by tier and survive transient billing proof failures", () => {
  const reviewCheck = smokeBillingCheck();
  assert.equal(resolveBillingTier(reviewCheck), "review");

  const proCheck: PartnerBillingCheck = {
    ...reviewCheck,
    verified: true,
    subscription: {
      ...reviewCheck.subscription!,
      items: [
        {
          handle: "stocky-pro",
          description: "Stocky Pro",
          price: null,
        },
      ],
    },
  };
  const pro = getPlanEntitlements(resolveBillingTier(proCheck));
  const basic = getPlanEntitlements("basic");

  assert.equal(canGenerateExport(basic, ExportType.ARCHIVE_CSV), true);
  assert.equal(
    canGenerateExport(basic, ExportType.SUPPLIER_RECONSTRUCTION_REPORT),
    true,
  );
  assert.equal(canGenerateExport(pro, ExportType.MIGRATION_CHECKLIST), true);
  assert.equal(basic.reviewKit, true);
  assert.equal(basic.locationAudit, true);
  assert.equal(pro.reviewKit, true);
  assert.equal(pro.locationAudit, true);
  assert.ok(basic.maxRowsPerBatch < pro.maxRowsPerBatch);

  const fallback = resolveBillingAccess({
    billingCheck: {
      ...reviewCheck,
      active: false,
      verified: false,
      subscription: null,
      errors: ["Partner API unavailable"],
    },
    billingStatus: BillingStatus.ACTIVE,
    storedPlan: "Stocky Plus",
    storedCheckedAt: new Date("2026-07-19T12:00:00.000Z"),
    now: new Date("2026-07-19T12:30:00.000Z"),
  });
  assert.equal(fallback.active, true);
  assert.equal(fallback.tier, "plus");
  assert.equal(fallback.usingLastVerifiedStatus, true);

  const expiredFallback = resolveBillingAccess({
    billingCheck: {
      ...reviewCheck,
      active: false,
      verified: false,
      subscription: null,
      errors: ["Partner API unavailable"],
    },
    billingStatus: BillingStatus.ACTIVE,
    storedPlan: "Stocky Plus",
    storedCheckedAt: new Date("2026-07-17T12:00:00.000Z"),
    now: new Date("2026-07-19T12:30:00.000Z"),
  });
  assert.equal(expiredFallback.active, false);
  assert.equal(expiredFallback.usingLastVerifiedStatus, false);

  const futureDatedFallback = resolveBillingAccess({
    billingCheck: {
      ...reviewCheck,
      active: false,
      verified: false,
      subscription: null,
      errors: ["Partner API unavailable"],
    },
    billingStatus: BillingStatus.ACTIVE,
    storedPlan: "Stocky Plus",
    storedCheckedAt: new Date("2026-07-20T12:00:00.000Z"),
    now: new Date("2026-07-19T12:30:00.000Z"),
  });
  assert.equal(futureDatedFallback.active, false);
  assert.equal(futureDatedFallback.usingLastVerifiedStatus, false);
});

test("upload limits reject oversized runs before creating database rows", () => {
  const basic = getPlanEntitlements("basic");
  const csv = (name: string, size: number) => ({ name, size }) as File;

  assert.throws(
    () =>
      validateUploadFiles({
        files: Array.from({ length: 11 }, (_, index) =>
          csv(`file-${index}.csv`, 1),
        ),
        entitlements: basic,
        currentStoredBytes: 0,
      }),
    /up to 10 files/,
  );
  assert.throws(
    () =>
      validateUploadFiles({
        files: [csv("too-large.csv", basic.maxFileBytes + 1)],
        entitlements: basic,
        currentStoredBytes: 0,
      }),
    /per-file limit/,
  );
  assert.throws(
    () =>
      validateUploadFiles({
        files: [csv("fits.csv", 2)],
        entitlements: basic,
        currentStoredBytes: basic.maxStoredBytes - 1,
      }),
    /stored-data allowance/,
  );
});

test("multipart parsing enforces the byte ceiling even without Content-Length", async () => {
  const smallBody = new FormData();
  smallBody.set("intent", "upload_csv");
  const smallRequest = new Request("https://example.invalid/app", {
    method: "POST",
    body: smallBody,
  });
  assert.equal(smallRequest.headers.has("content-length"), false);
  assert.equal(
    (await readFormDataWithinLimit(smallRequest, 10_000)).get("intent"),
    "upload_csv",
  );

  const largeBody = new FormData();
  largeBody.set("payload", "x".repeat(2_000));
  const largeRequest = new Request("https://example.invalid/app", {
    method: "POST",
    body: largeBody,
  });
  await assert.rejects(
    () => readFormDataWithinLimit(largeRequest, 256),
    RequestSizeLimitError,
  );

  const misleadingLengthBody = new FormData();
  misleadingLengthBody.set("payload", "x".repeat(2_000));
  const misleadingLengthRequest = new Request("https://example.invalid/app", {
    method: "POST",
    headers: { "Content-Length": "1" },
    body: misleadingLengthBody,
  });
  await assert.rejects(
    () => readFormDataWithinLimit(misleadingLengthRequest, 256),
    RequestSizeLimitError,
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

test("public support contact accepts only a normal email address", () => {
  const original = process.env.SUPPORT_EMAIL;

  try {
    process.env.SUPPORT_EMAIL = "support@example.com";
    assert.equal(getSupportEmail(), "support@example.com");
    process.env.SUPPORT_EMAIL = "support@example.com?subject=token";
    assert.equal(getSupportEmail(), null);
  } finally {
    if (original === undefined) {
      delete process.env.SUPPORT_EMAIL;
    } else {
      process.env.SUPPORT_EMAIL = original;
    }
  }
});

const smokeShop = "fixture-stocky-dev.myshopify.com";
const smokeResult = {
  shop: { id: "gid://shopify/Shop/1", myshopifyDomain: smokeShop },
  accessScopes: ["read_products", "read_inventory", "read_locations"],
  productSamples: 1,
  locationSamples: 1,
};

function smokeBillingCheck({
  active = true,
  errors = [],
}: {
  active?: boolean;
  errors?: string[];
} = {}): PartnerBillingCheck {
  return {
    active,
    verified: true,
    shop: smokeShop,
    shopId: smokeResult.shop.id,
    source: "Partner API activeSubscription",
    subscription: active
      ? {
          billingPeriod: "EVERY_30_DAYS",
          cancelAtEndOfCycle: false,
          trialEndsAt: null,
          currentBillingCycle: null,
          items: [
            {
              handle: PRIVATE_TEST_BILLING_PLAN,
              description: "Shopify Test",
              price: null,
            },
          ],
          legacySubscriptionId: null,
        }
      : null,
    missingEnv: [],
    errors,
  };
}

function smokeDependencies(
  overrides: Partial<
    NonNullable<Parameters<typeof runHostedSmokeProof>[0]["dependencies"]>
  > = {},
): NonNullable<Parameters<typeof runHostedSmokeProof>[0]["dependencies"]> {
  return {
    getAdmin: async () => ({ admin: {} as never, session: {} as never }),
    getSmokeResult: async () => smokeResult,
    getBillingCheck: async () => smokeBillingCheck(),
    ...overrides,
  };
}

test("hosted smoke lets the Shopify SDK refresh an expiring offline session", async () => {
  let sdkCalls = 0;
  const proof = await runHostedSmokeProof({
    shop: smokeShop,
    dependencies: smokeDependencies({
      getAdmin: async () => {
        sdkCalls += 1;
        return { admin: {} as never, session: {} as never };
      },
    }),
  });

  assert.equal(sdkCalls, 1);
  assert.equal(proof.status, 200);
  assert.equal(proof.body.ok, true);
  assert.equal(proof.body.tokenSource, "Shopify SDK offline session");
});

test("hosted smoke reports a missing offline session without exposing credentials", async () => {
  const error = new Error("Could not find a session for shop");
  error.name = "SessionNotFoundError";
  const proof = await runHostedSmokeProof({
    shop: smokeShop,
    dependencies: smokeDependencies({
      getAdmin: async () => {
        throw error;
      },
    }),
  });

  assert.equal(proof.status, 424);
  assert.equal(
    proof.body.error,
    `No offline Shopify session found for ${smokeShop}.`,
  );
});

test("hosted smoke sanitizes offline token refresh failures", async () => {
  const proof = await runHostedSmokeProof({
    shop: smokeShop,
    dependencies: smokeDependencies({
      getAdmin: async () => {
        throw new Error("refresh response contained sensitive upstream detail");
      },
    }),
  });

  assert.equal(proof.status, 424);
  assert.equal(
    proof.body.error,
    `The Shopify SDK could not refresh or use the offline session for ${smokeShop}.`,
  );
  assert.equal(JSON.stringify(proof.body).includes("sensitive"), false);
});

test("hosted smoke fails when required read-only scopes are missing", async () => {
  const proof = await runHostedSmokeProof({
    shop: smokeShop,
    dependencies: smokeDependencies({
      getSmokeResult: async () => ({
        ...smokeResult,
        accessScopes: ["read_products"],
      }),
    }),
  });

  assert.equal(proof.status, 424);
  assert.deepEqual(proof.body.failures?.slice(0, 2), [
    "Missing scope: read_inventory",
    "Missing scope: read_locations",
  ]);
});

test("hosted smoke preserves Partner API failures as diagnostic evidence", async () => {
  const proof = await runHostedSmokeProof({
    shop: smokeShop,
    dependencies: smokeDependencies({
      getBillingCheck: async () =>
        smokeBillingCheck({
          active: false,
          errors: ["Partner API returned no active subscription."],
        }),
    }),
  });

  assert.equal(proof.status, 424);
  assert.deepEqual(proof.body.failures, [
    "Partner API returned no active subscription.",
  ]);
});

test("hosted smoke returns successful scope, billing, product, and location proof", async () => {
  const proof = await runHostedSmokeProof({
    shop: smokeShop,
    dependencies: smokeDependencies(),
  });

  assert.equal(proof.status, 200);
  assert.equal(proof.body.ok, true);
  assert.deepEqual(proof.body.grantedScopes, [
    "read_inventory",
    "read_locations",
    "read_products",
  ]);
  assert.equal(proof.body.billingActive, true);
  assert.equal(proof.body.productSamples, 1);
  assert.equal(proof.body.locationSamples, 1);
});

test("store reset requires exact confirmation and deletes only store-scoped migration data", async () => {
  const calls: Array<{ model: string; where: unknown }> = [];
  const transaction = {
    exportJob: {
      deleteMany: async ({ where }: { where: unknown }) => (
        calls.push({ model: "exportJob", where }),
        { count: 4 }
      ),
    },
    auditFinding: {
      deleteMany: async ({ where }: { where: unknown }) => (
        calls.push({ model: "auditFinding", where }),
        { count: 62 }
      ),
    },
    shopifyCatalogSnapshot: {
      deleteMany: async ({ where }: { where: unknown }) => (
        calls.push({ model: "shopifyCatalogSnapshot", where }),
        { count: 1 }
      ),
    },
    uploadBatch: {
      deleteMany: async ({ where }: { where: unknown }) => (
        calls.push({ model: "uploadBatch", where }),
        { count: 1 }
      ),
    },
  };
  const database = {
    $transaction: async (callback: (client: typeof transaction) => unknown) =>
      callback(transaction),
  } as never;

  await assert.rejects(
    resetStoreMigrationData({
      storeId: "store-1",
      confirmation: "DELETE",
      database,
    }),
    /DELETE MIGRATION DATA/,
  );
  const result = await resetStoreMigrationData({
    storeId: "store-1",
    confirmation: RESET_CONFIRMATION,
    database,
  });

  assert.deepEqual(result, {
    exportJobs: 4,
    auditFindings: 62,
    catalogSnapshots: 1,
    uploadBatches: 1,
  });
  assert.deepEqual(calls, [
    { model: "exportJob", where: { storeId: "store-1" } },
    { model: "auditFinding", where: { storeId: "store-1" } },
    { model: "shopifyCatalogSnapshot", where: { storeId: "store-1" } },
    { model: "uploadBatch", where: { storeId: "store-1" } },
  ]);
});

test("one migration run can be deleted without removing other store data", async () => {
  const calls: Array<{ operation: string; where: unknown }> = [];
  const transaction = {
    uploadBatch: {
      findFirst: async ({ where }: { where: unknown }) => {
        calls.push({ operation: "find-run", where });
        return {
          id: "batch-1",
          auditSnapshotId: "snapshot-1",
          fileCount: 10,
          importedRowCount: 247,
        };
      },
      delete: async ({ where }: { where: unknown }) => {
        calls.push({ operation: "delete-run", where });
        return { id: "batch-1" };
      },
      count: async ({ where }: { where: unknown }) => {
        calls.push({ operation: "count-snapshot-links", where });
        return 0;
      },
    },
    shopifyCatalogSnapshot: {
      deleteMany: async ({ where }: { where: unknown }) => {
        calls.push({ operation: "delete-orphan-snapshot", where });
        return { count: 1 };
      },
    },
  };
  const database = {
    $transaction: async (callback: (client: typeof transaction) => unknown) =>
      callback(transaction),
  } as never;

  await assert.rejects(
    deleteStoreMigrationRun({
      storeId: "store-1",
      batchId: "batch-1",
      confirmation: "DELETE",
      database,
    }),
    /DELETE THIS RUN/,
  );
  const result = await deleteStoreMigrationRun({
    storeId: "store-1",
    batchId: "batch-1",
    confirmation: DELETE_RUN_CONFIRMATION,
    database,
  });

  assert.deepEqual(result, {
    uploadBatch: 1,
    files: 10,
    parsedRows: 247,
    catalogSnapshots: 1,
  });
  assert.deepEqual(calls, [
    {
      operation: "find-run",
      where: { id: "batch-1", storeId: "store-1" },
    },
    { operation: "delete-run", where: { id: "batch-1" } },
    {
      operation: "count-snapshot-links",
      where: { auditSnapshotId: "snapshot-1" },
    },
    {
      operation: "delete-orphan-snapshot",
      where: { id: "snapshot-1", storeId: "store-1" },
    },
  ]);
});

test("existing migration reports stay downloadable after billing ends", () => {
  const exportRoute = readFileSync(
    path.join(process.cwd(), "app", "routes", "app.exports.$type.tsx"),
    "utf8",
  );
  const reviewKitRoute = readFileSync(
    path.join(process.cwd(), "app", "routes", "app.review-kit.tsx"),
    "utf8",
  );

  assert.doesNotMatch(exportRoute, /if \(!billingAccess\.active\)/);
  assert.doesNotMatch(reviewKitRoute, /if \(!billingAccess\.active\)/);
  assert.match(reviewKitRoute, /billingAccess\.entitlements\.reviewKit/);
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
  assert.equal(getNormalized(firstPoRecord, "supplierSku"), "SUP-REF-771");
  assert.equal(getNormalized(firstPoRecord, "quantity"), "6");
  assert.equal(getNormalized(firstPoRecord, "totalCost"), "75,00");
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
  assert.equal(vendors.warningCount, 4);
  assert.equal(
    vendors.records.some((record) => record.warnings.includes("missing_sku")),
    false,
  );

  const unknown = parseStockyFixture("stocky-unknown-export.csv");
  assert.equal(unknown.reportType, StockyReportType.UNKNOWN);
  assert.deepEqual(unknown.unknownColumns, ["Export Label", "Freeform Value"]);
  assert.equal(unknown.warningCount, 2);

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
    assert.equal(result.fileCount, 10);
    assert.equal(result.failedFileCount, 1);
    assert.equal(result.importedRowCount, expectedImportedRows);
    assert.equal(result.importedRowCount, 38);
    assert.equal(result.warningCount, expectedWarnings);
    assert.equal(result.warningCount, 32);

    const [batch] = fakeDb.state.uploadBatches;
    assert.equal(batch.status, UploadBatchStatus.IMPORTED);
    assert.equal(batch.fileCount, fixtureFilenames.length);
    assert.equal(batch.importedRowCount, expectedImportedRows);
    assert.equal(batch.auditSnapshotId ?? null, null);
    assert.equal(fakeDb.state.uploadedFiles.length, fixtureFilenames.length);
    assert.equal(
      fakeDb.state.uploadedFiles.every(
        (file) =>
          typeof file.rawContentBase64 === "string" &&
          typeof file.contentSha256 === "string" &&
          typeof file.rawContentByteLength === "number" &&
          file.parseMetadata !== null,
      ),
      true,
    );
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
    const seededSnapshot = fakeDb.seedCatalogSnapshot({
      storeId: store.id,
      summary: catalog,
    });

    const auditResult = await regenerateAuditFindings({
      storeId: store.id,
      batchId: result.batchId,
    });
    assert.ok(auditResult.created > 0);
    assert.equal(
      fakeDb.state.uploadBatches[0].auditSnapshotId,
      seededSnapshot.id,
    );
    assert.ok(fakeDb.state.uploadBatches[0].auditedAt);

    const otherStore = fakeDb.createStore("other-stocky-dev.myshopify.com");
    const findingCountBeforeOwnershipCheck = fakeDb.state.auditFindings.length;
    const crossStoreAudit = await regenerateAuditFindings({
      storeId: otherStore.id,
      batchId: result.batchId,
      snapshotId: seededSnapshot.id,
    });
    assert.equal(crossStoreAudit.created, 0);
    assert.equal(
      fakeDb.state.auditFindings.length,
      findingCountBeforeOwnershipCheck,
    );
    const exportJobsBeforeOwnershipCheck = fakeDb.state.exportJobs.length;
    await assert.rejects(
      generateExport({
        storeId: otherStore.id,
        batchId: result.batchId,
        exportType: ExportType.ARCHIVE_CSV,
      }),
      /selected migration run was not found/i,
    );
    assert.equal(
      fakeDb.state.exportJobs.length,
      exportJobsBeforeOwnershipCheck,
    );

    const categories = new Set(
      fakeDb.state.auditFindings.map((finding) => finding.category),
    );
    assert.equal(fakeDb.state.auditFindings.length, 57);
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
    const missingSkuFindings = fakeDb.state.auditFindings.filter(
      (finding) => finding.category === FindingCategory.MISSING_SKU,
    );
    assert.equal(
      missingSkuFindings.some((finding) =>
        ["stocky-vendors.csv", "stocky-unknown-export.csv"].includes(
          String((finding.source as { filename?: string } | null)?.filename),
        ),
      ),
      false,
    );
    assert.equal(
      missingSkuFindings.every((finding) =>
        Array.isArray(
          (finding.source as { sourceRowNumbers?: unknown } | null)
            ?.sourceRowNumbers,
        ),
      ),
      true,
    );
    const stockyDuplicateFindings = fakeDb.state.auditFindings.filter(
      (finding) =>
        finding.category === FindingCategory.DUPLICATE_SKU &&
        finding.title === "Product export contains duplicate SKU rows",
    );
    assert.equal(stockyDuplicateFindings.length, 1);
    assert.equal(
      (stockyDuplicateFindings[0].source as { filename?: string }).filename,
      "stocky-products-edge-cases.csv",
    );
    assert.equal(
      fakeDb.state.auditFindings.some(
        (finding) =>
          finding.category === FindingCategory.PARSE_ERROR &&
          finding.title === "CSV contains duplicate header names",
      ),
      true,
    );
    assert.equal(
      fakeDb.state.auditFindings.some(
        (finding) =>
          finding.category === FindingCategory.PARSE_ERROR &&
          finding.title === "CSV rows have a different column count",
      ),
      true,
    );
    const openPurchaseOrderFindings = fakeDb.state.auditFindings.filter(
      (finding) =>
        finding.category === FindingCategory.OPEN_PURCHASE_ORDER_INDICATOR,
    );
    assert.equal(openPurchaseOrderFindings.length, 4);
    assert.equal(
      openPurchaseOrderFindings.some((finding) =>
        finding.message.includes("PO-1045"),
      ),
      true,
    );

    const otherBatch = await importStockyCsvFiles({
      storeId: store.id,
      files: [
        new File(
          ["SKU,Title\nOTHER-BATCH-ONLY,Other batch item\n"],
          "other-batch-only.csv",
          {
            type: "text/csv",
          },
        ),
      ],
    });
    assert.notEqual(otherBatch.batchId, result.batchId);

    const archive = await generateExport({
      storeId: store.id,
      batchId: result.batchId,
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
    assert.doesNotMatch(archive.body, /OTHER-BATCH-ONLY/);

    const auditFindings = await generateExport({
      storeId: store.id,
      batchId: result.batchId,
      exportType: ExportType.SKU_GAP_REPORT,
    });
    assert.ok(
      auditFindings.body.startsWith(
        "severity,category,sku,title,message,recommended_action,source_file,source_rows,source_evidence_json,created_at",
      ),
    );
    assert.match(auditFindings.body, /UNMATCHED_SHOPIFY_SKU/);
    assert.match(auditFindings.body, /LOCATION_MISMATCH/);
    assert.match(auditFindings.body, /PARSE_ERROR/);
    assert.match(auditFindings.body, /OPEN_PURCHASE_ORDER_INDICATOR/);
    assert.match(auditFindings.body, /SUPPLIER_RECONSTRUCTION_CANDIDATE/);
    assert.match(auditFindings.body, /stocky-products-edge-cases\.csv,8/);

    const supplier = await generateExport({
      storeId: store.id,
      batchId: result.batchId,
      exportType: ExportType.SUPPLIER_RECONSTRUCTION_REPORT,
    });
    assert.ok(
      supplier.body.startsWith(
        "sku,title,supplier_hint,vendor_hint,supplier_sku_hint,source_file,source_row,stocky_reference,stocky_status,stocky_quantity,stocky_unit_cost,stocky_location,stocky_date,recommended_action",
      ),
    );
    assert.match(supplier.body, /SUP-REF-771/);
    assert.match(supplier.body, /TrailForge/);
    assert.match(
      supplier.body,
      /Supplier records cannot be exported directly from Stocky/,
    );
    assert.match(supplier.body, /Supplier SKU evidence/);

    const checklist = await generateExport({
      storeId: store.id,
      batchId: result.batchId,
      exportType: ExportType.MIGRATION_CHECKLIST,
    });
    assert.ok(checklist.body.startsWith("item,status,evidence,next_action"));
    assert.match(checklist.body, /Upload Stocky CSV exports/);
    assert.match(
      checklist.body,
      /Historical Stocky purchase orders cannot be imported as Shopify history/i,
    );
    assert.match(checklist.body, /Confirm core historical report types/);
    assert.match(checklist.body, /report presence alone cannot prove/i);
    assert.match(checklist.body, /Rebuild supplier records/);
    assert.match(checklist.body, /Set the purchasing cutover/);
    assert.match(checklist.body, /Test Shopify replacement workflows/);
    assert.match(checklist.body, /Train staff and remove the Stocky POS tile/);
    assert.match(checklist.body, /Update Stocky-dependent integrations/);
    assert.match(checklist.body, /use the Open PO import files in Exports/i);

    const priorityChecklist = await generateExport({
      storeId: store.id,
      batchId: result.batchId,
      exportType: ExportType.MIGRATION_CHECKLIST,
      options: { priorityChecklist: true },
    });
    assert.ok(
      priorityChecklist.body.startsWith(
        "priority,item,status,evidence,next_action",
      ),
    );

    const openPoImports = await generateOpenPurchaseOrderImportPackage({
      storeId: store.id,
      batchId: result.batchId,
    });
    const openPoEntries = unzipSync(openPoImports.bytes);
    assert.equal(openPoImports.readyPurchaseOrderCount, 3);
    assert.equal(openPoImports.readyLineCount, 3);
    assert.equal(openPoImports.excludedLineCount, 2);
    assert.equal(
      openPoImports.filename,
      getOpenPurchaseOrderImportFilename(
        fakeDb.state.uploadBatches.find((batch) => batch.id === result.batchId)
          ?.createdAt ?? new Date(0),
      ),
    );
    assert.deepEqual(
      Object.keys(openPoEntries)
        .filter((filename) => filename.startsWith("shopify-import/"))
        .sort(),
      [
        "shopify-import/PO-1042.csv",
        "shopify-import/PO-1043.csv",
        "shopify-import/PO-2001.csv",
      ],
    );
    assert.equal(
      Buffer.from(openPoEntries["shopify-import/PO-2001.csv"])
        .toString("utf8")
        .split("\n")[0],
      "SKU,Barcode,Supplier SKU,Quantity,Cost,Tax",
    );
    assert.match(
      Buffer.from(openPoEntries["shopify-import/PO-2001.csv"]).toString("utf8"),
      /PLUS\+SKU\.1,,SUP-REF-771,6,12\.50,/,
    );
    const manualReviewLines = Buffer.from(
      openPoEntries["manual-review-lines.csv"],
    ).toString("utf8");
    const purchaseOrderSummary = Buffer.from(
      openPoEntries["purchase-order-summary.csv"],
    ).toString("utf8");
    assert.match(purchaseOrderSummary, /PO-1042[^\n]*,1,1,/);
    assert.match(purchaseOrderSummary, /PO-1045[^\n]*,0,1,/);
    assert.match(manualReviewLines, /PO-1042/);
    assert.match(manualReviewLines, /unsafe_remaining_quantity/);
    assert.match(manualReviewLines, /PO-1045/);
    assert.match(manualReviewLines, /missing_shopify_variant_identifier/);
    assert.match(
      Buffer.from(openPoEntries["README.txt"]).toString("utf8"),
      /do not import historical Stocky purchase orders as history/i,
    );

    const reviewKit = await generateReviewKit({
      storeId: store.id,
      batchId: result.batchId,
    });
    const zipEntries = unzipSync(reviewKit.bytes);
    const runCreatedAt = fakeDb.state.uploadBatches.find(
      (batch) => batch.id === result.batchId,
    )?.createdAt;
    assert.ok(runCreatedAt);
    const runStamp = formatRunFilenameStamp(runCreatedAt);
    const zipNames = Object.keys(zipEntries).sort();
    assert.deepEqual(
      zipNames.filter((filename) => !filename.startsWith("source/")),
      [
        "manifest.json",
        `stocky-audit-findings-run-${runStamp}.csv`,
        `stocky-migration-checklist-run-${runStamp}.csv`,
        `stocky-open-po-imports-run-${runStamp}.zip`,
        `stocky-parsed-archive-run-${runStamp}.csv`,
        `stocky-supplier-evidence-run-${runStamp}.csv`,
      ],
    );
    assert.equal(reviewKit.filename, getReviewKitFilename(runCreatedAt));
    assert.equal(
      zipNames.filter((filename) => filename.startsWith("source/")).length,
      fixtureFilenames.length,
    );
    assert.equal(
      zipNames.some((filename) =>
        filename.endsWith("stocky-malformed-unclosed-quote.csv"),
      ),
      true,
    );
    const manifest = JSON.parse(
      Buffer.from(zipEntries["manifest.json"]).toString("utf8"),
    ) as {
      batchId: string;
      files: Array<{ filename: string; bytes: number; sha256: string }>;
    };
    assert.equal(manifest.batchId, result.batchId);
    assert.equal(manifest.files.length, 5 + fixtureFilenames.length);
    for (const file of manifest.files) {
      const bytes = Buffer.from(zipEntries[file.filename]);
      assert.equal(bytes.byteLength, file.bytes);
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        file.sha256,
      );
    }

    assert.equal(
      fakeDb.state.exportJobs.length,
      Object.values(ExportType).length * 2 + 1,
    );
    assert.deepEqual(
      fakeDb.state.exportJobs.map((job) => job.status),
      Array.from(
        { length: Object.values(ExportType).length * 2 + 1 },
        () => ExportStatus.SUCCEEDED,
      ),
    );
  } finally {
    fakeDb.restore();
  }
});

test("review kit fails closed when preserved source bytes are unavailable", async () => {
  const fakeDb = installInMemoryPrisma();
  const store = fakeDb.createStore("missing-source-stocky-dev.myshopify.com");

  try {
    const result = await importStockyCsvFiles({
      storeId: store.id,
      files: [
        new File(["SKU,Title\nSOURCE-1,Preserved item\n"], "source.csv", {
          type: "text/csv",
        }),
      ],
    });
    const source = fakeDb.state.uploadedFiles[0];
    assert.ok(source);
    source.rawContentBase64 = null;

    await assert.rejects(
      () =>
        generateReviewKit({
          storeId: store.id,
          batchId: result.batchId,
        }),
      /Preserved source bytes are unavailable for source\.csv/,
    );
    assert.equal(fakeDb.state.exportJobs.length, 0);
  } finally {
    fakeDb.restore();
  }
});

test("migration runs fail individual files before exceeding the parsed-row ceiling", async () => {
  const fakeDb = installInMemoryPrisma();
  const store = fakeDb.createStore("row-limit-stocky-dev.myshopify.com");

  try {
    const entitlements = {
      ...getPlanEntitlements("basic"),
      maxRowsPerFile: 10,
      maxRowsPerBatch: 2,
    };
    const result = await importStockyCsvFiles({
      storeId: store.id,
      entitlements,
      files: [
        new File(["SKU,Title\nONE,One\nTWO,Two\n"], "first.csv", {
          type: "text/csv",
        }),
        new File(["SKU,Title\nTHREE,Three\n"], "second.csv", {
          type: "text/csv",
        }),
      ],
    });

    assert.equal(result.importedRowCount, 2);
    assert.equal(result.failedFileCount, 1);
    assert.equal(fakeDb.state.parsedRecords.length, 2);
    const failed = fakeDb.state.uploadedFiles.find(
      (file) => file.originalFilename === "second.csv",
    );
    assert.equal(failed?.parseStatus, FileParseStatus.FAILED);
    assert.match(failed?.errorMessage ?? "", /parsed-row limit/);
  } finally {
    fakeDb.restore();
  }
});

test("header-only Stocky exports remain preserved as successful empty evidence", async () => {
  const fakeDb = installInMemoryPrisma();
  const store = fakeDb.createStore("empty-evidence-stocky-dev.myshopify.com");

  try {
    const result = await importStockyCsvFiles({
      storeId: store.id,
      files: [
        new File(["SKU,Title,Vendor\n"], "empty-products.csv", {
          type: "text/csv",
        }),
      ],
    });

    assert.equal(result.importedRowCount, 0);
    assert.equal(result.failedFileCount, 0);
    assert.equal(
      fakeDb.state.uploadBatches[0]?.status,
      UploadBatchStatus.IMPORTED,
    );
    assert.equal(
      fakeDb.state.uploadedFiles[0]?.parseStatus,
      FileParseStatus.PARSED,
    );
    assert.equal(fakeDb.state.uploadedFiles[0]?.rawContentByteLength, 17);

    const checklist = await generateExport({
      storeId: store.id,
      batchId: result.batchId,
      exportType: ExportType.MIGRATION_CHECKLIST,
      options: { priorityChecklist: true },
    });
    assert.match(
      checklist.body,
      /Upload Stocky CSV exports,done,"1 successfully parsed source file, 0 parsed rows"/,
    );
    assert.match(
      checklist.body,
      /Confirm core historical report types,needs_attention,Core: none; Supplemental: products or custom SKUs/,
    );
  } finally {
    fakeDb.restore();
  }
});

test("zero-byte CSV uploads remain preserved as failed evidence", async () => {
  const fakeDb = installInMemoryPrisma();
  const store = fakeDb.createStore("zero-byte-stocky-dev.myshopify.com");

  try {
    const formData = new FormData();
    formData.append(
      "csvFiles",
      new File([], "empty.csv", { type: "text/csv" }),
    );
    const files = getUploadedFiles(formData);

    assert.equal(files.length, 1);
    assert.equal(files[0].size, 0);

    const result = await importStockyCsvFiles({
      storeId: store.id,
      files,
    });

    assert.equal(result.importedRowCount, 0);
    assert.equal(result.failedFileCount, 1);
    assert.equal(fakeDb.state.uploadedFiles[0]?.rawContentByteLength, 0);
    assert.equal(fakeDb.state.uploadedFiles[0]?.rawContentBase64, "");
    assert.equal(
      fakeDb.state.uploadedFiles[0]?.contentSha256,
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    assert.match(
      fakeDb.state.uploadedFiles[0]?.errorMessage ?? "",
      /header row/,
    );
  } finally {
    fakeDb.restore();
  }
});

test("header-only files retain file-level unknown and duplicate-column findings", async () => {
  const fakeDb = installInMemoryPrisma();
  const store = fakeDb.createStore("header-metadata-stocky-dev.myshopify.com");

  try {
    const result = await importStockyCsvFiles({
      storeId: store.id,
      files: [
        new File(
          ["SKU,sku,Custom Evidence\n"],
          "header-metadata-products.csv",
          { type: "text/csv" },
        ),
      ],
    });

    assert.equal(result.importedRowCount, 0);
    assert.equal(result.failedFileCount, 0);
    assert.equal(result.warningCount, 2);
    assert.deepEqual(
      fakeDb.state.auditFindings.map((finding) => finding.title).sort(),
      [
        "CSV contains duplicate header names",
        "CSV contains unrecognized columns",
      ],
    );
  } finally {
    fakeDb.restore();
  }
});

test("whitespace-only uploads fail while preserving their original bytes", async () => {
  const fakeDb = installInMemoryPrisma();
  const store = fakeDb.createStore("blank-evidence-stocky-dev.myshopify.com");

  try {
    const result = await importStockyCsvFiles({
      storeId: store.id,
      files: [new File([" \r\n\t"], "blank.csv", { type: "text/csv" })],
    });

    assert.equal(result.importedRowCount, 0);
    assert.equal(result.failedFileCount, 1);
    assert.equal(
      fakeDb.state.uploadBatches[0]?.status,
      UploadBatchStatus.FAILED,
    );
    assert.equal(
      fakeDb.state.uploadedFiles[0]?.parseStatus,
      FileParseStatus.FAILED,
    );
    assert.match(
      fakeDb.state.uploadedFiles[0]?.errorMessage ?? "",
      /header row/,
    );
    assert.equal(
      Buffer.from(
        fakeDb.state.uploadedFiles[0]?.rawContentBase64 ?? "",
        "base64",
      ).toString("utf8"),
      " \r\n\t",
    );
  } finally {
    fakeDb.restore();
  }
});

test("invalid normalized values become visible parser findings", async () => {
  const fakeDb = installInMemoryPrisma();
  const store = fakeDb.createStore("invalid-values-stocky-dev.myshopify.com");

  try {
    await importStockyCsvFiles({
      storeId: store.id,
      files: [
        new File(
          [
            "SKU,Unit Cost,Qty,Date\n",
            "BAD-VALUES,not-money,twelve,2026-99-99\n",
          ],
          "invalid-products.csv",
          { type: "text/csv" },
        ),
      ],
    });

    const titles = fakeDb.state.auditFindings
      .filter((finding) => finding.category === FindingCategory.PARSE_ERROR)
      .map((finding) => finding.title);
    assert.deepEqual(titles.sort(), [
      "Cost values could not be interpreted",
      "Date values could not be interpreted",
      "Quantity values could not be interpreted",
    ]);
  } finally {
    fakeDb.restore();
  }
});

test("in-transit Stocky purchase orders remain visible as cutover work", async () => {
  const fakeDb = installInMemoryPrisma();
  const store = fakeDb.createStore("in-transit-stocky-dev.myshopify.com");

  try {
    const result = await importStockyCsvFiles({
      storeId: store.id,
      files: [
        new File(
          [
            "PO Number,Status,SKU,Qty Ordered\n",
            "PO-TRANSIT,In Transit,TRANSIT-1,4\n",
          ],
          "stocky-purchase-orders.csv",
          { type: "text/csv" },
        ),
      ],
    });

    assert.equal(result.importedRowCount, 1);
    const finding = fakeDb.state.auditFindings.find(
      (candidate) =>
        candidate.category === FindingCategory.OPEN_PURCHASE_ORDER_INDICATOR,
    );
    assert.ok(finding);
    assert.match(finding.message, /PO-TRANSIT/);
    assert.match(finding.message, /In Transit/);
    assert.match(
      finding.recommendedAction,
      /download the Open PO import files from Exports/i,
    );
  } finally {
    fakeDb.restore();
  }
});

test("audit generation reads large parsed files in bounded pages", async () => {
  const fakeDb = installInMemoryPrisma();
  const store = fakeDb.createStore("paged-audit-stocky-dev.myshopify.com");
  const rows = Array.from(
    { length: 501 },
    (_, index) => `SKU-${String(index + 1).padStart(4, "0")},Fixture vendor`,
  );

  try {
    const result = await importStockyCsvFiles({
      storeId: store.id,
      files: [
        new File([`SKU,Vendor\n${rows.join("\n")}\n`], "paged-products.csv", {
          type: "text/csv",
        }),
      ],
    });

    assert.equal(result.importedRowCount, 501);
    assert.equal(fakeDb.state.auditFindings.length, 501);
    assert.equal(
      fakeDb.state.auditFindings.every(
        (finding) =>
          finding.category ===
          FindingCategory.SUPPLIER_RECONSTRUCTION_CANDIDATE,
      ),
      true,
    );

    fakeDb.queryStats.parsedRecordFindMany.length = 0;
    const archive = await generateExport({
      storeId: store.id,
      batchId: result.batchId,
      exportType: ExportType.ARCHIVE_CSV,
    });
    assert.equal(archive.body.split("\n").length, 502);
    assert.deepEqual(fakeDb.queryStats.parsedRecordFindMany, [
      { take: 500, distinct: false },
      { take: 500, distinct: false },
    ]);
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

function catalogVariantEdge(id: string, sku: string) {
  return {
    cursor: `cursor-${id}`,
    node: {
      id: `gid://shopify/ProductVariant/${id}`,
      sku,
      barcode: null,
      displayName: `Fixture variant ${id}`,
      product: {
        id: `gid://shopify/Product/${id}`,
        title: `Fixture product ${id}`,
        vendor: "Fixture vendor",
      },
      inventoryItem: {
        id: `gid://shopify/InventoryItem/${id}`,
        sku,
        unitCost: { amount: "1.00", currencyCode: "USD" },
      },
    },
  };
}

type StoreRow = {
  id: string;
  shop: string;
  installed: boolean;
  scopes: string | null;
  billingStatus: BillingStatus;
  billingPlan: string | null;
  billingCheckedAt: Date | null;
  billingEndedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  uninstalledAt: Date | null;
};

type UploadBatchRow = {
  id: string;
  storeId: string;
  auditSnapshotId: string | null;
  status: UploadBatchStatus;
  fileCount: number;
  importedRowCount: number;
  warningCount: number;
  auditedAt: Date | null;
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
  parseMetadata: Prisma.JsonValue | null;
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
  batchId: string | null;
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
      | "status"
      | "importedRowCount"
      | "warningCount"
      | "fileCount"
      | "auditSnapshotId"
      | "auditedAt"
    >
  >;
};

type UploadBatchFindUniqueArgs = {
  where: { id: string };
};

type UploadBatchFindFirstArgs = {
  where?: { id?: string; storeId?: string };
  include?: {
    auditSnapshot?: boolean;
    uploadedFiles?: {
      include?: { parsedRecords?: boolean };
    };
  };
  select?: {
    uploadedFiles?: unknown;
    [key: string]: unknown;
  };
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
    parseMetadata?: Prisma.InputJsonValue;
    rowCount?: number;
    warningCount?: number;
    errorMessage?: string | null;
  };
};

type UploadedFileFindManyArgs = {
  where?: {
    parseStatus?: FileParseStatus;
    batch?: {
      id?: string;
      storeId?: string;
    };
  };
  select?: Record<string, unknown>;
};

type UploadedFileFindFirstArgs = {
  where?: {
    id?: string;
    batch?: {
      id?: string;
      storeId?: string;
    };
  };
  select?: Record<string, unknown>;
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
    uploadedFileId?: string;
    uploadedFile?: {
      batch?: {
        storeId?: string;
        id?: string;
      };
    };
  };
  orderBy?: Array<Record<string, "asc" | "desc">>;
  take?: number;
  cursor?: { id: string };
  skip?: number;
  include?: {
    uploadedFile?: boolean;
  };
  select?: {
    uploadedFile?: unknown;
    [key: string]: unknown;
  };
  distinct?: Array<"normalizedType">;
};

type ParsedRecordCountArgs = {
  where?: ParsedRecordFindManyArgs["where"];
};

type CatalogSnapshotFindFirstArgs = {
  where?: {
    id?: string;
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
    batchId?: string | null;
    severity?: FindingSeverity;
    category?:
      FindingCategory | { in: FindingCategory[] } | { not: FindingCategory };
  };
  orderBy?: Array<Record<string, "asc" | "desc">>;
};

type AuditFindingGroupByArgs = {
  by: Array<"severity" | "category">;
  where?: AuditFindingFindManyArgs["where"];
  _count: { _all: true };
};

type AuditFindingCountArgs = {
  where?: AuditFindingFindManyArgs["where"];
};

type ExportJobCreateArgs = {
  data: {
    storeId: string;
    batchId?: string | null;
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
  const queryStats = {
    parsedRecordFindMany: [] as Array<{
      take: number | null;
      distinct: boolean;
    }>,
  };
  const patchedKeys = [
    "$transaction",
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
      billingPlan: "Stocky Review Test",
      billingCheckedAt: now(),
      billingEndedAt: null,
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
  mutableDb.$transaction = async (
    callback: (client: typeof db) => Promise<unknown>,
  ) => callback(db);
  mutableDb.uploadBatch = {
    create: async ({ data }: UploadBatchCreateArgs) => {
      const batch: UploadBatchRow = {
        id: nextId("batch"),
        storeId: data.storeId,
        auditSnapshotId: null,
        status: data.status ?? UploadBatchStatus.PENDING,
        fileCount: data.fileCount ?? 0,
        importedRowCount: 0,
        warningCount: 0,
        auditedAt: null,
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
    findFirst: async ({
      where,
      include,
      select,
    }: UploadBatchFindFirstArgs = {}) => {
      const batch = state.uploadBatches.find(
        (row) =>
          (!where?.id || row.id === where.id) &&
          (!where?.storeId || row.storeId === where.storeId),
      );

      if (!batch) {
        return null;
      }

      if (include?.uploadedFiles || select?.uploadedFiles) {
        return {
          ...withUploadedFiles(batch, state),
          ...(include?.auditSnapshot
            ? {
                auditSnapshot:
                  state.catalogSnapshots.find(
                    (snapshot) => snapshot.id === batch.auditSnapshotId,
                  ) ?? null,
              }
            : {}),
        };
      }

      if (!include?.auditSnapshot) {
        return batch ?? null;
      }

      return {
        ...batch,
        auditSnapshot:
          state.catalogSnapshots.find(
            (snapshot) => snapshot.id === batch.auditSnapshotId,
          ) ?? null,
      };
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
        parseMetadata:
          data.parseMetadata === undefined
            ? null
            : (data.parseMetadata as Prisma.JsonValue),
        rowCount: data.rowCount ?? 0,
        warningCount: data.warningCount ?? 0,
        errorMessage: data.errorMessage ?? null,
        createdAt: now(),
        updatedAt: now(),
      };

      state.uploadedFiles.push(file);
      return file;
    },
    findMany: async ({ where }: UploadedFileFindManyArgs = {}) =>
      state.uploadedFiles.filter((file) => {
        const batch = state.uploadBatches.find(
          (candidate) => candidate.id === file.batchId,
        );

        return (
          (!where?.parseStatus || file.parseStatus === where.parseStatus) &&
          (!where?.batch?.id || batch?.id === where.batch.id) &&
          (!where?.batch?.storeId || batch?.storeId === where.batch.storeId)
        );
      }),
    findFirst: async ({ where }: UploadedFileFindFirstArgs = {}) =>
      state.uploadedFiles.find((file) => {
        const batch = state.uploadBatches.find(
          (candidate) => candidate.id === file.batchId,
        );

        return (
          (!where?.id || file.id === where.id) &&
          (!where?.batch?.id || batch?.id === where.batch.id) &&
          (!where?.batch?.storeId || batch?.storeId === where.batch.storeId)
        );
      }) ?? null,
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
      queryStats.parsedRecordFindMany.push({
        take: args.take ?? null,
        distinct: Boolean(args.distinct?.length),
      });
      const storeId = args.where?.uploadedFile?.batch?.storeId;
      const batchId = args.where?.uploadedFile?.batch?.id;
      let rows = state.parsedRecords.filter(
        (record) =>
          (!args.where?.uploadedFileId ||
            record.uploadedFileId === args.where.uploadedFileId) &&
          (!storeId || recordBelongsToStore(record, storeId, state)) &&
          (!batchId || recordBelongsToBatch(record, batchId, state)),
      );
      rows = sortRows(rows, args.orderBy);

      if (args.distinct?.includes("normalizedType")) {
        const seen = new Set<StockyReportType>();
        rows = rows.filter((record) => {
          if (seen.has(record.normalizedType)) return false;
          seen.add(record.normalizedType);
          return true;
        });
      }

      if (args.cursor) {
        const cursorIndex = rows.findIndex(
          (record) => record.id === args.cursor?.id,
        );
        rows = rows.slice(
          cursorIndex >= 0 ? cursorIndex + (args.skip ?? 0) : 0,
        );
      } else if (args.skip) {
        rows = rows.slice(args.skip);
      }

      if (args.take !== undefined) {
        rows = rows.slice(0, args.take);
      }

      if (!args.include?.uploadedFile && !args.select?.uploadedFile) {
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
      const batchId = args.where?.uploadedFile?.batch?.id;

      return state.parsedRecords.filter(
        (record) =>
          (!storeId || recordBelongsToStore(record, storeId, state)) &&
          (!batchId || recordBelongsToBatch(record, batchId, state)),
      ).length;
    },
  };
  mutableDb.shopifyCatalogSnapshot = {
    findFirst: async (args: CatalogSnapshotFindFirstArgs = {}) => {
      let rows = state.catalogSnapshots.filter((snapshot) => {
        if (args.where?.id && snapshot.id !== args.where.id) {
          return false;
        }

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
    groupBy: async (args: AuditFindingGroupByArgs) => {
      const groups = new Map<
        string,
        {
          severity: FindingSeverity;
          category: FindingCategory;
          _count: { _all: number };
        }
      >();

      for (const finding of state.auditFindings.filter((candidate) =>
        matchesAuditFindingWhere(candidate, args.where),
      )) {
        const key = `${finding.severity}|${finding.category}`;
        const group = groups.get(key) ?? {
          severity: finding.severity,
          category: finding.category,
          _count: { _all: 0 },
        };
        group._count._all += 1;
        groups.set(key, group);
      }

      return [...groups.values()];
    },
  };
  mutableDb.exportJob = {
    create: async ({ data }: ExportJobCreateArgs) => {
      const job: ExportJobRow = {
        id: nextId("export"),
        storeId: data.storeId,
        batchId: data.batchId ?? null,
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
    queryStats,
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

function recordBelongsToBatch(
  record: ParsedRecordRow,
  batchId: string,
  state: InMemoryState,
) {
  const file = state.uploadedFiles.find(
    (candidate) => candidate.id === record.uploadedFileId,
  );

  return file?.batchId === batchId;
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
      if ("in" in where.category) {
        return where.category.in.includes(finding.category);
      }

      return finding.category !== where.category.not;
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
