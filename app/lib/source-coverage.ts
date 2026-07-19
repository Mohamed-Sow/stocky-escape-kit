export const CORE_STOCKY_REPORT_TYPES = [
  "PURCHASE_ORDERS",
  "STOCKTAKES",
  "HISTORICAL_COSTS",
] as const;

export const SUPPLEMENTAL_STOCKY_REPORT_TYPES = [
  "PRODUCTS",
  "INVENTORY_ACTIVITY",
] as const;

export type StockySourceReportType =
  | (typeof CORE_STOCKY_REPORT_TYPES)[number]
  | (typeof SUPPLEMENTAL_STOCKY_REPORT_TYPES)[number];

const REPORT_LABELS: Record<StockySourceReportType, string> = {
  PRODUCTS: "products or custom SKUs",
  PURCHASE_ORDERS: "purchase orders",
  STOCKTAKES: "stocktakes",
  HISTORICAL_COSTS: "historical stock-on-hand or cost reports",
  INVENTORY_ACTIVITY: "inventory activity",
};

export function resolveStockySourceCoverage(
  files: ReadonlyArray<{ reportType: string; status: string }>,
) {
  const successfullyParsed = new Set(
    files
      .filter((file) => file.status === "PARSED")
      .map((file) => file.reportType),
  );
  const covered = CORE_STOCKY_REPORT_TYPES.filter((reportType) =>
    successfullyParsed.has(reportType),
  );
  const missing = CORE_STOCKY_REPORT_TYPES.filter(
    (reportType) => !successfullyParsed.has(reportType),
  );
  const supplementalCovered = SUPPLEMENTAL_STOCKY_REPORT_TYPES.filter(
    (reportType) => successfullyParsed.has(reportType),
  );

  return {
    coreTypesRepresented: missing.length === 0,
    covered,
    missing,
    supplementalCovered,
    total: CORE_STOCKY_REPORT_TYPES.length,
  };
}

export function stockyReportTypeLabel(reportType: StockySourceReportType) {
  return REPORT_LABELS[reportType];
}
