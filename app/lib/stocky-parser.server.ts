import { StockyReportType } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { parseCsv } from "./csv.server";
import type { StockyCsvEncoding } from "./text-decoding.server";

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
  metadata: Prisma.InputJsonObject;
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
  shopifyId: ["shopify_id", "shopify_product_id", "shopify_variant_id"],
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
    "origin",
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
    "total_cost",
  ],
  retailValue: [
    "retail_price",
    "retail_value",
    "total_retail",
    "stock_value",
  ],
  adjustmentCost: [
    "adjustment_cost",
    "adjustment_total_cost",
    "total_adjustment_cost",
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
    "total_items",
    "total_quantity",
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
  reason: ["reason", "adjustment_reason", "transfer_reason"],
  employee: ["employee", "staff", "staff_name", "employee_name"],
} as const;

const KNOWN_COLUMNS: Set<string> = new Set(Object.values(FIELD_ALIASES).flat());

export function parseStockyCsv({
  filename,
  content,
  sourceEncoding,
}: {
  filename: string;
  content: string;
  sourceEncoding?: StockyCsvEncoding;
}): ParsedStockyFile {
  const csv = parseCsv(content);
  const parseErrors = [...csv.errors];

  if (csv.headers.length === 0) {
    parseErrors.push("CSV does not contain a header row.");
  }

  const headerColumns = buildHeaderColumns(csv.headers);
  const normalizedHeaders = headerColumns.map((column) => column.normalized);

  const reportType = detectReportType(filename, normalizedHeaders);
  const unknownColumns = csv.headers.filter(
    (header) => !KNOWN_COLUMNS.has(normalizeHeader(header)),
  );
  const duplicateHeaders = findDuplicateHeaders(csv.headers);
  const metadata: Prisma.InputJsonObject = {
    headers: csv.headers,
    unknownColumns,
    ...(duplicateHeaders.length > 0 ? { duplicateHeaders } : {}),
    ...(sourceEncoding ? { sourceEncoding } : {}),
  };

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

    if (normalized.cost && !isPlausibleNumber(normalized.cost)) {
      warnings.push("invalid_cost");
    }

    if (normalized.quantity && !isPlausibleNumber(normalized.quantity)) {
      warnings.push("invalid_quantity");
    }

    if (normalized.date && !isPlausibleDate(normalized.date)) {
      warnings.push("invalid_date");
    }

    return {
      sourceRowNumber,
      sku: normalized.sku,
      normalizedPayload: {
        sourceFilename: filename,
        reportType,
        raw,
        normalized,
        meta: metadata,
      },
      warnings,
    };
  });

  const warningCount =
    parseErrors.length +
    unknownColumns.length +
    duplicateHeaders.length +
    records.reduce((sum, record) => sum + record.warnings.length, 0);

  return {
    reportType,
    rowCount: records.length,
    warningCount,
    unknownColumns,
    parseErrors,
    metadata,
    records,
  };
}

export function reportRequiresSku(reportType: StockyReportType) {
  return (
    reportType !== StockyReportType.VENDORS &&
    reportType !== StockyReportType.HISTORICAL_COSTS &&
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
  const normalizedName = normalizeHeader(name.replace(/\.[^.]+$/, ""));
  const headerSet = new Set(headers);
  const hasSkuColumn = FIELD_ALIASES.sku.some((alias) => headerSet.has(alias));
  const hasDateColumn = FIELD_ALIASES.date.some((alias) =>
    headerSet.has(alias),
  );
  const hasHistoricalFilename =
    normalizedName.includes("historical") ||
    normalizedName.includes("history");

  if (
    name.includes("purchase") ||
    /(^|_)po(_|$)/.test(normalizedName) ||
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
    normalizedName.includes("stocktake") ||
    headerSet.has("stocktake_number") ||
    headerSet.has("counted") ||
    headerSet.has("actual_stock") ||
    headerSet.has("expected_stock")
  ) {
    return StockyReportType.STOCKTAKES;
  }

  if (
    normalizedName.includes("activity") ||
    normalizedName.includes("adjustment") ||
    normalizedName.includes("transfer") ||
    headerSet.has("activity_type") ||
    headerSet.has("quantity_change") ||
    headerSet.has("transfer_number") ||
    (headerSet.has("reason") &&
      (headerSet.has("employee") || headerSet.has("origin")))
  ) {
    return StockyReportType.INVENTORY_ACTIVITY;
  }

  if (
    (hasHistoricalFilename &&
      (normalizedName.includes("cost") ||
        normalizedName.includes("stock") ||
        normalizedName.includes("on_hand"))) ||
    (hasDateColumn &&
      (headerSet.has("average_cost") ||
        headerSet.has("landed_cost") ||
        headerSet.has("total_cost") ||
        headerSet.has("total_retail") ||
        headerSet.has("total_items")))
  ) {
    return StockyReportType.HISTORICAL_COSTS;
  }

  if (
    !hasSkuColumn &&
    (name.includes("vendor") ||
      name.includes("supplier") ||
      headerSet.has("supplier_name"))
  ) {
    return StockyReportType.VENDORS;
  }

  if (
    name.includes("product") ||
    headerSet.has("product_name") ||
    headerSet.has("barcode") ||
    hasSkuColumn
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
    shopifyId: valueFor(raw, headerColumns, FIELD_ALIASES.shopifyId),
    vendor: valueFor(raw, headerColumns, FIELD_ALIASES.vendor),
    supplier: valueFor(raw, headerColumns, FIELD_ALIASES.supplier),
    location: valueFor(raw, headerColumns, FIELD_ALIASES.location),
    cost: valueFor(raw, headerColumns, FIELD_ALIASES.cost),
    retailValue: valueFor(raw, headerColumns, FIELD_ALIASES.retailValue),
    adjustmentCost: valueFor(
      raw,
      headerColumns,
      FIELD_ALIASES.adjustmentCost,
    ),
    quantity: valueFor(raw, headerColumns, FIELD_ALIASES.quantity),
    status: valueFor(raw, headerColumns, FIELD_ALIASES.status),
    date: valueFor(raw, headerColumns, FIELD_ALIASES.date),
    reference: valueFor(raw, headerColumns, FIELD_ALIASES.reference),
    reason: valueFor(raw, headerColumns, FIELD_ALIASES.reason),
    employee: valueFor(raw, headerColumns, FIELD_ALIASES.employee),
  };
}

function valueFor(
  raw: Record<string, string>,
  headerColumns: HeaderColumn[],
  aliases: readonly string[],
) {
  for (const alias of aliases) {
    const matchingColumns = headerColumns.filter(
      (column) => column.normalized === alias,
    );

    for (const column of matchingColumns) {
      if (raw[column.rawKey]?.trim()) {
        return raw[column.rawKey].trim();
      }
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
  const counts = new Map<string, { count: number; display: string }>();

  for (const header of headers) {
    const normalized = normalizeHeader(header);
    const current = counts.get(normalized);
    counts.set(normalized, {
      count: (current?.count ?? 0) + 1,
      display: current?.display ?? (header.trim() || "(blank header)"),
    });
  }

  return [...counts.entries()]
    .filter(([, value]) => value.count > 1)
    .map(([, value]) => value.display);
}

function isPlausibleNumber(value: string) {
  let candidate = value.trim();

  if (/^\(.*\)$/.test(candidate)) {
    candidate = `-${candidate.slice(1, -1)}`;
  }

  candidate = candidate
    .replace(/^[A-Z]{3}\s*/i, "")
    .replace(/\s*[A-Z]{3}$/i, "")
    .replace(/[$£€¥₹]/g, "")
    .replace(/[\s']/g, "");

  return [
    /^[+-]?\d+$/,
    /^[+-]?\d+[.,]\d+$/,
    /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/,
    /^[+-]?\d{1,3}(?:\.\d{3})+(?:,\d+)?$/,
  ].some((pattern) => pattern.test(candidate));
}

function isPlausibleDate(value: string) {
  const candidate = value.trim();
  const isoLike = candidate.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(.*)$/);

  if (isoLike) {
    const validDate = isCalendarDate(
      Number(isoLike[1]),
      Number(isoLike[2]),
      Number(isoLike[3]),
    );
    const suffix = isoLike[4].trim();
    return validDate && (!suffix || Number.isFinite(Date.parse(candidate)));
  }

  const common = candidate.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/);
  if (common) {
    const year = Number(common[3]);
    const fullYear = year < 100 ? 2000 + year : year;
    const first = Number(common[1]);
    const second = Number(common[2]);
    return (
      isCalendarDate(fullYear, first, second) ||
      isCalendarDate(fullYear, second, first)
    );
  }

  if (/^\d{1,5}(?:\.\d+)?$/.test(candidate)) {
    const serial = Number(candidate);
    return serial >= 1 && serial <= 100_000;
  }

  return /[a-z]/i.test(candidate) && Number.isFinite(Date.parse(candidate));
}

function isCalendarDate(year: number, month: number, day: number) {
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1) {
    return false;
  }

  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}
