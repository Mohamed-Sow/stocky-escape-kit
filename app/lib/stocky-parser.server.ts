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
  sku: [
    "sku",
    "variant_sku",
    "product_sku",
    "stock_keeping_unit",
    "stock_code",
    "item_code",
    "item_id",
    "supplier_sku",
    "vendor_sku",
  ],
  title: [
    "title",
    "product_title",
    "product_name",
    "name",
    "variant_title",
    "item_name",
    "item_description",
    "description",
  ],
  barcode: [
    "barcode",
    "bar_code",
    "ean",
    "upc",
    "gtin",
    "isbn",
    "barcode_isbn",
    "variant_barcode",
    "upc_ean",
    "ean_upc",
  ],
  vendor: ["vendor", "vendor_name", "brand", "product_vendor"],
  supplier: [
    "supplier",
    "supplier_name",
    "supplier_code",
    "vendor_code",
    "supplier_ref",
  ],
  location: [
    "location",
    "location_name",
    "stock_location",
    "warehouse",
    "receive_location",
    "destination",
    "from_location",
    "to_location",
  ],
  cost: [
    "cost",
    "unit_cost",
    "cost_base",
    "cost_price",
    "cost_per_item",
    "average_cost",
    "avg_cost",
    "landed_cost",
    "unit_price",
  ],
  quantity: [
    "quantity",
    "qty",
    "qty_ordered",
    "qty_received",
    "quantity_ordered",
    "quantity_received",
    "stock_on_hand",
    "on_hand",
    "qty_on_hand",
    "soh",
    "counted",
    "actual_stock",
    "expected_stock",
    "stock_count",
    "available",
    "variant_inventory_qty",
    "adjustment",
    "quantity_change",
    "adjustment_total",
  ],
  status: [
    "status",
    "line_status",
    "po_status",
    "purchase_order_status",
    "received_status",
  ],
  date: [
    "date",
    "created_at",
    "order_date",
    "po_date",
    "invoice_date",
    "expected_date",
    "ship_date",
    "cancel_date",
    "received_at",
    "completed_at",
    "completed_date",
    "effective_date",
  ],
  reference: [
    "reference",
    "po",
    "p_o",
    "purchase_order",
    "purchase_order_number",
    "po_number",
    "p_o_number",
    "order_number",
    "invoice_number",
    "supplier_order_number",
    "stocktake_number",
    "transfer_number",
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
  const headerColumns = buildHeaderColumns(csv.headers);
  const normalizedHeaders = headerColumns.map((column) => column.normalized);

  const reportType = detectReportType(filename, normalizedHeaders);
  const unknownColumns = csv.headers.filter(
    (header) => !KNOWN_COLUMNS.has(normalizeHeader(header)),
  );
  const duplicateHeaders = findDuplicateHeaders(csv.headers);

  const records = csv.rows.map(({ sourceRowNumber, values }) => {
    const raw = Object.fromEntries(
      headerColumns.map((column, index) => [
        column.rawKey,
        values[index]?.trim() ?? "",
      ]),
    );
    const normalized = extractNormalizedFields(raw, headerColumns);
    const warnings: string[] = [];

    if (reportRequiresSku(reportType) && !normalized.sku) {
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
          ...(duplicateHeaders.length > 0 ? { duplicateHeaders } : {}),
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

export function reportRequiresSku(reportType: StockyReportType) {
  return (
    reportType !== StockyReportType.VENDORS &&
    reportType !== StockyReportType.UNKNOWN
  );
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
    headerSet.has("po") ||
    headerSet.has("p_o") ||
    headerSet.has("purchase_order") ||
    headerSet.has("po_number") ||
    headerSet.has("p_o_number") ||
    (headerSet.has("supplier_order_number") &&
      (headerSet.has("qty_ordered") || headerSet.has("quantity_ordered")))
  ) {
    return StockyReportType.PURCHASE_ORDERS;
  }

  if (
    name.includes("stocktake") ||
    headerSet.has("stocktake_number") ||
    headerSet.has("counted") ||
    headerSet.has("actual_stock") ||
    headerSet.has("expected_stock") ||
    headerSet.has("adjustment_total")
  ) {
    return StockyReportType.STOCKTAKES;
  }

  if (
    name.includes("activity") ||
    headerSet.has("activity_type") ||
    headerSet.has("quantity_change") ||
    headerSet.has("transfer_number")
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
  headerColumns: HeaderColumn[],
) {
  return {
    sku: valueFor(raw, headerColumns, FIELD_ALIASES.sku),
    title: valueFor(raw, headerColumns, FIELD_ALIASES.title),
    barcode: valueFor(raw, headerColumns, FIELD_ALIASES.barcode),
    vendor: valueFor(raw, headerColumns, FIELD_ALIASES.vendor),
    supplier: valueFor(raw, headerColumns, FIELD_ALIASES.supplier),
    location: valueFor(raw, headerColumns, FIELD_ALIASES.location),
    cost: valueFor(raw, headerColumns, FIELD_ALIASES.cost),
    quantity: valueFor(raw, headerColumns, FIELD_ALIASES.quantity),
    status: valueFor(raw, headerColumns, FIELD_ALIASES.status),
    date: valueFor(raw, headerColumns, FIELD_ALIASES.date),
    reference: valueFor(raw, headerColumns, FIELD_ALIASES.reference),
  };
}

function valueFor(
  raw: Record<string, string>,
  headerColumns: HeaderColumn[],
  aliases: readonly string[],
) {
  for (const alias of aliases) {
    const sourceHeader = headerColumns.find(
      (column) => column.normalized === alias,
    )?.rawKey;

    if (sourceHeader && raw[sourceHeader]?.trim()) {
      return raw[sourceHeader].trim();
    }
  }

  return null;
}

type HeaderColumn = {
  original: string;
  normalized: string;
  rawKey: string;
};

function buildHeaderColumns(headers: string[]): HeaderColumn[] {
  const seen = new Map<string, number>();

  return headers.map((header) => {
    const count = (seen.get(header) ?? 0) + 1;
    seen.set(header, count);

    return {
      original: header,
      normalized: normalizeHeader(header),
      rawKey: count === 1 ? header : `${header} #${count}`,
    };
  });
}

function findDuplicateHeaders(headers: string[]) {
  const counts = new Map<string, number>();

  for (const header of headers) {
    counts.set(header, (counts.get(header) ?? 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([header]) => header);
}
