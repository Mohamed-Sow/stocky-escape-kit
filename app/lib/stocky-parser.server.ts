import { StockyReportType } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { parseCsv } from "./csv.server";

type ParsedStockyRecord = {
  sourceRowNumber: number;
  sku: string | null;
  normalizedPayload: Prisma.InputJsonObject;
  warnings: string[];
};

export type ParsedStockyFile = {
  reportType: StockyReportType;
  rowCount: number;
  warningCount: number;
  unknownColumns: string[];
  parseErrors: string[];
  records: ParsedStockyRecord[];
};

const FIELD_ALIASES = {
  sku: ["sku", "variant_sku", "product_sku", "stock_keeping_unit"],
  title: ["title", "product_title", "product_name", "name", "variant_title"],
  barcode: ["barcode", "bar_code", "ean", "upc"],
  vendor: ["vendor", "vendor_name", "brand"],
  supplier: ["supplier", "supplier_name", "supplier_code"],
  location: ["location", "location_name", "stock_location", "warehouse"],
  cost: ["cost", "unit_cost", "average_cost", "avg_cost", "landed_cost"],
  quantity: [
    "quantity",
    "qty",
    "stock_on_hand",
    "on_hand",
    "counted",
    "available",
    "adjustment",
    "quantity_change",
  ],
  status: ["status", "po_status", "purchase_order_status"],
  date: ["date", "created_at", "order_date", "received_at", "completed_at"],
  reference: [
    "reference",
    "purchase_order",
    "purchase_order_number",
    "po_number",
    "order_number",
    "stocktake_number",
  ],
} as const;

const KNOWN_COLUMNS: Set<string> = new Set(Object.values(FIELD_ALIASES).flat());

export function parseStockyCsv({
  filename,
  content,
}: {
  filename: string;
  content: string;
}): ParsedStockyFile {
  const csv = parseCsv(content);
  const normalizedHeaders = csv.headers.map(normalizeHeader);
  const headerByNormalized = new Map<string, string>();

  csv.headers.forEach((header, index) => {
    headerByNormalized.set(normalizedHeaders[index] ?? "", header);
  });

  const reportType = detectReportType(filename, normalizedHeaders);
  const unknownColumns = csv.headers.filter(
    (header) => !KNOWN_COLUMNS.has(normalizeHeader(header)),
  );

  const records = csv.rows.map(({ sourceRowNumber, values }) => {
    const raw = Object.fromEntries(
      csv.headers.map((header, index) => [header, values[index]?.trim() ?? ""]),
    );
    const normalized = extractNormalizedFields(raw, headerByNormalized);
    const warnings: string[] = [];

    if (!normalized.sku) {
      warnings.push("missing_sku");
    }

    if (csv.headers.length !== values.length) {
      warnings.push("column_count_mismatch");
    }

    return {
      sourceRowNumber,
      sku: normalized.sku,
      normalizedPayload: {
        sourceFilename: filename,
        reportType,
        raw,
        normalized,
        meta: {
          headers: csv.headers,
          unknownColumns,
        },
      },
      warnings,
    };
  });

  const warningCount =
    csv.errors.length +
    unknownColumns.length +
    records.reduce((sum, record) => sum + record.warnings.length, 0);

  return {
    reportType,
    rowCount: records.length,
    warningCount,
    unknownColumns,
    parseErrors: csv.errors,
    records,
  };
}

export function normalizeHeader(header: string) {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function detectReportType(filename: string, headers: string[]) {
  const name = filename.toLowerCase();
  const headerSet = new Set(headers);

  if (
    name.includes("purchase") ||
    name.includes("po_") ||
    headerSet.has("purchase_order") ||
    headerSet.has("po_number")
  ) {
    return StockyReportType.PURCHASE_ORDERS;
  }

  if (
    name.includes("stocktake") ||
    headerSet.has("stocktake_number") ||
    headerSet.has("counted")
  ) {
    return StockyReportType.STOCKTAKES;
  }

  if (
    name.includes("activity") ||
    headerSet.has("activity_type") ||
    headerSet.has("quantity_change")
  ) {
    return StockyReportType.INVENTORY_ACTIVITY;
  }

  if (
    name.includes("cost") ||
    headerSet.has("average_cost") ||
    headerSet.has("landed_cost")
  ) {
    return StockyReportType.HISTORICAL_COSTS;
  }

  if (
    name.includes("vendor") ||
    name.includes("supplier") ||
    (headerSet.has("supplier_name") && !headerSet.has("sku"))
  ) {
    return StockyReportType.VENDORS;
  }

  if (
    name.includes("product") ||
    headerSet.has("product_name") ||
    headerSet.has("barcode") ||
    headerSet.has("sku")
  ) {
    return StockyReportType.PRODUCTS;
  }

  return StockyReportType.UNKNOWN;
}

function extractNormalizedFields(
  raw: Record<string, string>,
  headerByNormalized: Map<string, string>,
) {
  return {
    sku: valueFor(raw, headerByNormalized, FIELD_ALIASES.sku),
    title: valueFor(raw, headerByNormalized, FIELD_ALIASES.title),
    barcode: valueFor(raw, headerByNormalized, FIELD_ALIASES.barcode),
    vendor: valueFor(raw, headerByNormalized, FIELD_ALIASES.vendor),
    supplier: valueFor(raw, headerByNormalized, FIELD_ALIASES.supplier),
    location: valueFor(raw, headerByNormalized, FIELD_ALIASES.location),
    cost: valueFor(raw, headerByNormalized, FIELD_ALIASES.cost),
    quantity: valueFor(raw, headerByNormalized, FIELD_ALIASES.quantity),
    status: valueFor(raw, headerByNormalized, FIELD_ALIASES.status),
    date: valueFor(raw, headerByNormalized, FIELD_ALIASES.date),
    reference: valueFor(raw, headerByNormalized, FIELD_ALIASES.reference),
  };
}

function valueFor(
  raw: Record<string, string>,
  headerByNormalized: Map<string, string>,
  aliases: readonly string[],
) {
  for (const alias of aliases) {
    const sourceHeader = headerByNormalized.get(alias);

    if (sourceHeader && raw[sourceHeader]?.trim()) {
      return raw[sourceHeader].trim();
    }
  }

  return null;
}
