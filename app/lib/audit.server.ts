import {
  FindingCategory,
  FindingSeverity,
  StockyReportType,
  SyncStatus,
} from "@prisma/client";
import type { Prisma } from "@prisma/client";
import db from "../db.server";
import { readCatalogSummary, type CatalogVariant } from "./catalog.server";
import {
  isOpenPurchaseOrderStatus,
  recoverOpenPurchaseOrderEvidence,
  resolveOpenPurchaseOrderQuantity,
} from "./open-purchase-orders";
import { reportRequiresSku } from "./stocky-parser.server";

type NormalizedPayload = {
  sourceFilename?: string;
  reportType?: StockyReportType;
  raw?: Record<string, string>;
  normalized?: {
    sku?: string | null;
    supplierSku?: string | null;
    title?: string | null;
    barcode?: string | null;
    vendor?: string | null;
    supplier?: string | null;
    location?: string | null;
    cost?: string | null;
    quantity?: string | null;
    quantityOrdered?: string | null;
    quantityReceived?: string | null;
    quantityOutstanding?: string | null;
    taxRate?: string | null;
    status?: string | null;
    date?: string | null;
    reference?: string | null;
  };
  meta?: {
    unknownColumns?: string[];
    duplicateHeaders?: string[];
    sourceEncoding?: string;
  };
};

type FileParseMetadata = NonNullable<NormalizedPayload["meta"]>;

type PendingFinding = {
  severity: FindingSeverity;
  category: FindingCategory;
  sku: string | null;
  title: string;
  message: string;
  recommendedAction: string;
  source?: Prisma.InputJsonObject;
};

export async function regenerateAuditFindings({
  storeId,
  batchId,
  snapshotId,
  includeLocationMismatches = true,
}: {
  storeId: string;
  batchId: string;
  snapshotId?: string | null;
  includeLocationMismatches?: boolean;
}) {
  const snapshotPromise =
    snapshotId === null
      ? Promise.resolve(null)
      : db.shopifyCatalogSnapshot.findFirst({
          where: snapshotId
            ? { id: snapshotId, storeId, syncStatus: SyncStatus.SUCCEEDED }
            : { storeId, syncStatus: SyncStatus.SUCCEEDED },
          orderBy: { syncedAt: "desc" },
        });
  const [batch, snapshot] = await Promise.all([
    db.uploadBatch.findFirst({
      where: { id: batchId, storeId },
      select: {
        id: true,
        uploadedFiles: {
          select: {
            id: true,
            originalFilename: true,
            detectedReportType: true,
            parseStatus: true,
            errorMessage: true,
            parseMetadata: true,
          },
        },
      },
    }),
    snapshotPromise,
  ]);

  if (!batch) {
    return { created: 0 };
  }

  const catalog = readCatalogSummary(snapshot?.summary ?? null);
  const catalogBySku = new Map<string, CatalogVariant[]>();

  for (const variant of catalog?.variants ?? []) {
    if (!variant.sku) {
      continue;
    }

    const key = variant.sku.toLowerCase();
    catalogBySku.set(key, [...(catalogBySku.get(key) ?? []), variant]);
  }

  const locationNames = new Set(
    (catalog?.locations ?? []).map((location) => location.name.toLowerCase()),
  );
  const pending = new Map<string, PendingFinding>();

  for (const file of batch.uploadedFiles) {
    const missingSku = { count: 0, rows: [] as number[] };
    const productSkuCounts = new Map<
      string,
      { displaySku: string; count: number }
    >();
    const parserWarnings = new Map<string, { count: number; rows: number[] }>();
    const openPurchaseOrders = new Map<
      string,
      {
        reference: string | null;
        statuses: Set<string>;
        sourceRowNumbers: number[];
        skus: Set<string>;
        lineCount: number;
        importReadyLineCount: number;
        manualReviewLineCount: number;
        lineEvidence: Array<{
          sourceRowNumber: number;
          sku: string | null;
          status: string | null;
          quantity: string | null;
          quantityOrdered: string | null;
          quantityReceived: string | null;
          quantityOutstanding: string | null;
          shopifyImportQuantity: number | null;
          quantityBasis: string;
          supplierSku: string | null;
          barcode: string | null;
          taxRate: string | null;
          cost: string | null;
          location: string | null;
          date: string | null;
        }>;
      }
    >();

    if (file.parseStatus === "FAILED") {
      addFinding(pending, {
        severity: FindingSeverity.CRITICAL,
        category: FindingCategory.PARSE_ERROR,
        sku: null,
        title: "CSV file did not parse",
        message: `${file.originalFilename}: ${file.errorMessage ?? "Unknown parse failure."}`,
        recommendedAction:
          "Re-export this Stocky report as CSV and upload the replacement file.",
        source: {
          fileId: file.id,
          filename: file.originalFilename,
        },
      });
    }

    const storedFileMetadata = readFileMetadata(file.parseMetadata);
    let recordedFileMetadata = Boolean(storedFileMetadata);

    if (storedFileMetadata) {
      addFileMetadataFindings(
        pending,
        file.id,
        file.originalFilename,
        storedFileMetadata,
      );
    }

    for await (const record of iterateParsedRecords(file.id)) {
      const payload = readPayload(record.normalizedPayload);

      if (!recordedFileMetadata) {
        if (payload.meta) {
          addFileMetadataFindings(
            pending,
            file.id,
            file.originalFilename,
            payload.meta,
          );
        }

        recordedFileMetadata = true;
      }

      const normalized =
        file.detectedReportType === StockyReportType.PURCHASE_ORDERS
          ? {
              ...(payload.normalized ?? {}),
              ...recoverOpenPurchaseOrderEvidence(payload),
            }
          : (payload.normalized ?? {});
      const sku =
        file.detectedReportType === StockyReportType.PURCHASE_ORDERS
          ? normalized.sku?.trim() || null
          : record.sku?.trim() || normalized.sku?.trim() || null;

      for (const warning of readWarnings(record.warnings)) {
        if (warning === "missing_sku") continue;
        const current = parserWarnings.get(warning) ?? { count: 0, rows: [] };
        current.count += 1;
        if (current.rows.length < 200) {
          current.rows.push(record.sourceRowNumber);
        }
        parserWarnings.set(warning, current);
      }

      if (sku && file.detectedReportType === StockyReportType.PRODUCTS) {
        const key = sku.toLowerCase();
        const current = productSkuCounts.get(key);
        productSkuCounts.set(key, {
          displaySku: current?.displaySku ?? sku,
          count: (current?.count ?? 0) + 1,
        });
      }

      if (
        normalized.supplier ||
        normalized.vendor ||
        normalized.supplierSku
      ) {
        const supplier = normalized.supplier?.trim() || null;
        const vendor = normalized.vendor?.trim() || null;
        const supplierSku = normalized.supplierSku?.trim() || null;
        const evidence = supplier ?? vendor ?? supplierSku ?? "Unknown";

        addFinding(pending, {
          severity: FindingSeverity.INFO,
          category: FindingCategory.SUPPLIER_RECONSTRUCTION_CANDIDATE,
          sku,
          title: supplier
            ? "Supplier evidence preserved from Stocky"
            : vendor
              ? "Vendor evidence may help identify a supplier"
              : "Supplier SKU evidence preserved from Stocky",
          message: sku
            ? `${sku} has ${supplier ? "supplier" : vendor ? "vendor-only" : "supplier-SKU"} evidence from ${evidence}.`
            : `${evidence} appears in ${file.originalFilename} as ${supplier ? "supplier" : vendor ? "vendor-only" : "supplier-SKU"} evidence without a product SKU.`,
          recommendedAction: supplier
            ? "Use purchase-order and custom SKU report evidence to rebuild supplier records manually. Stocky supplier records cannot be exported directly."
            : vendor
              ? "Treat this vendor value as a lead, not proof of the supplier. Confirm it against purchase orders or custom SKU reports before recreating supplier records."
              : "Use this as the optional Supplier SKU when recreating an open line, but confirm the supplier separately because a supplier SKU does not identify the supplier business.",
          source: sourceFor(
            file.originalFilename,
            record.sourceRowNumber,
            payload,
          ),
        });
      }

      if (
        file.detectedReportType === StockyReportType.PURCHASE_ORDERS &&
        isOpenPurchaseOrderStatus(normalized.status)
      ) {
        const reference = normalized.reference?.trim() || null;
        const key = reference?.toLowerCase() ?? `row:${record.sourceRowNumber}`;
        const purchaseOrder = openPurchaseOrders.get(key) ?? {
          reference,
          statuses: new Set<string>(),
          sourceRowNumbers: [],
          skus: new Set<string>(),
          lineCount: 0,
          importReadyLineCount: 0,
          manualReviewLineCount: 0,
          lineEvidence: [],
        };

        const quantityResolution = resolveOpenPurchaseOrderQuantity({
          status: normalized.status,
          quantity: normalized.quantity,
          quantityOrdered: normalized.quantityOrdered,
          quantityReceived: normalized.quantityReceived,
          quantityOutstanding: normalized.quantityOutstanding,
        });

        purchaseOrder.statuses.add(normalized.status?.trim() || "unknown");
        purchaseOrder.lineCount += 1;
        if (quantityResolution.quantity === null || (!sku && !normalized.barcode)) {
          purchaseOrder.manualReviewLineCount += 1;
        } else {
          purchaseOrder.importReadyLineCount += 1;
        }
        if (purchaseOrder.sourceRowNumbers.length < 200) {
          purchaseOrder.sourceRowNumbers.push(record.sourceRowNumber);
        }
        if (sku) purchaseOrder.skus.add(sku);
        if (purchaseOrder.lineEvidence.length < 200) {
          purchaseOrder.lineEvidence.push({
            sourceRowNumber: record.sourceRowNumber,
            sku,
            status: normalized.status?.trim() || null,
            quantity: normalized.quantity?.trim() || null,
            quantityOrdered: normalized.quantityOrdered?.trim() || null,
            quantityReceived: normalized.quantityReceived?.trim() || null,
            quantityOutstanding:
              normalized.quantityOutstanding?.trim() || null,
            shopifyImportQuantity: quantityResolution.quantity,
            quantityBasis: quantityResolution.basis,
            supplierSku: normalized.supplierSku?.trim() || null,
            barcode: normalized.barcode?.trim() || null,
            taxRate: normalized.taxRate?.trim() || null,
            cost: normalized.cost?.trim() || null,
            location: normalized.location?.trim() || null,
            date: normalized.date?.trim() || null,
          });
        }
        openPurchaseOrders.set(key, purchaseOrder);
      }

      if (!sku) {
        if (reportRequiresSku(file.detectedReportType)) {
          missingSku.count += 1;
          if (missingSku.rows.length < 200) {
            missingSku.rows.push(record.sourceRowNumber);
          }
        }

        continue;
      }

      const shopifyMatches = catalogBySku.get(sku.toLowerCase()) ?? [];

      if (catalog && shopifyMatches.length === 0) {
        addFinding(pending, {
          severity: FindingSeverity.CRITICAL,
          category: FindingCategory.UNMATCHED_SHOPIFY_SKU,
          sku,
          title: "Stocky SKU not found in Shopify",
          message: `${sku} appears in Stocky exports but was not found in the latest Shopify catalog sync.`,
          recommendedAction:
            "Confirm whether the product was removed, renamed, or uses a different Shopify SKU before migration.",
          source: sourceFor(
            file.originalFilename,
            record.sourceRowNumber,
            payload,
          ),
        });
      }

      if (shopifyMatches.length > 1) {
        addFinding(pending, {
          severity: FindingSeverity.WARNING,
          category: FindingCategory.DUPLICATE_SKU,
          sku,
          title: "Shopify has duplicate variants for this SKU",
          message: `${sku} matched ${shopifyMatches.length} Shopify variants.`,
          recommendedAction:
            "Resolve duplicate Shopify SKUs before relying on Stocky-to-Shopify matching or reconciliation.",
          source: {
            ...sourceFor(
              file.originalFilename,
              record.sourceRowNumber,
              payload,
            ),
            variants: shopifyMatches.map((variant) => variant.displayName),
          },
        });
      }

      for (const match of shopifyMatches) {
        if (!match.unitCost) {
          addFinding(pending, {
            severity: FindingSeverity.WARNING,
            category: FindingCategory.MISSING_COST,
            sku,
            title: "Shopify unit cost is missing",
            message: `${sku} has no readable Shopify unit cost on ${match.displayName}.`,
            recommendedAction:
              "Add the product cost in Shopify, or confirm that the cost is intentionally unavailable before relying on cost comparisons.",
            source: sourceFor(
              file.originalFilename,
              record.sourceRowNumber,
              payload,
            ),
          });
        }

        if (!match.barcode) {
          addFinding(pending, {
            severity: FindingSeverity.WARNING,
            category: FindingCategory.MISSING_BARCODE,
            sku,
            title: "Shopify barcode is missing",
            message: `${sku} has no Shopify barcode on ${match.displayName}.`,
            recommendedAction:
              "Add the barcode in Shopify if Stocky exports or downstream workflows rely on it.",
            source: sourceFor(
              file.originalFilename,
              record.sourceRowNumber,
              payload,
            ),
          });
        }

        if (!match.vendor) {
          addFinding(pending, {
            severity: FindingSeverity.WARNING,
            category: FindingCategory.MISSING_VENDOR,
            sku,
            title: "Shopify vendor is missing",
            message: `${sku} has no Shopify vendor on ${match.displayName}.`,
            recommendedAction:
              "Fill the Shopify vendor field or preserve supplier evidence from Stocky exports.",
            source: sourceFor(
              file.originalFilename,
              record.sourceRowNumber,
              payload,
            ),
          });
        }
      }

      if (
        includeLocationMismatches &&
        catalog &&
        normalized.location &&
        !locationNames.has(normalized.location.toLowerCase())
      ) {
        addFinding(pending, {
          severity: FindingSeverity.WARNING,
          category: FindingCategory.LOCATION_MISMATCH,
          sku,
          title: "Stocky location not found in Shopify",
          message: `${normalized.location} appears in Stocky exports but not in synced Shopify locations.`,
          recommendedAction:
            "Map this Stocky location to a Shopify location before using location-level reports.",
          source: sourceFor(
            file.originalFilename,
            record.sourceRowNumber,
            payload,
          ),
        });
      }
    }

    for (const [warning, affected] of parserWarnings) {
      const copy = parserWarningCopy(warning);
      const sample = affected.rows.slice(0, 8).join(", ");
      const remainder = affected.count - Math.min(8, affected.count);

      addFinding(pending, {
        severity: FindingSeverity.WARNING,
        category: FindingCategory.PARSE_ERROR,
        sku: null,
        title: copy.title,
        message: `${file.originalFilename} has ${affected.count} affected row${affected.count === 1 ? "" : "s"} (${sample}${remainder > 0 ? `, plus ${remainder} more` : ""}).`,
        recommendedAction: copy.recommendedAction,
        source: {
          fileId: file.id,
          filename: file.originalFilename,
          parserWarning: warning,
          affectedRowCount: affected.count,
          sourceRowNumbers: affected.rows,
        },
      });
    }

    if (missingSku.count > 0) {
      const sample = missingSku.rows.slice(0, 8).join(", ");
      const remainder = missingSku.count - Math.min(8, missingSku.count);

      addFinding(pending, {
        severity: FindingSeverity.CRITICAL,
        category: FindingCategory.MISSING_SKU,
        sku: null,
        title: "Source file contains rows without SKUs",
        message: `${file.originalFilename} has ${missingSku.count} row${missingSku.count === 1 ? "" : "s"} that cannot be matched to Shopify without a SKU (row${missingSku.count === 1 ? "" : "s"} ${sample}${remainder > 0 ? `, plus ${remainder} more` : ""}).`,
        recommendedAction:
          "Recover the missing SKUs or preserve these rows for manual review before relying on SKU-level migration results.",
        source: {
          fileId: file.id,
          filename: file.originalFilename,
          affectedRowCount: missingSku.count,
          sourceRowNumbers: missingSku.rows,
        },
      });
    }

    for (const { displaySku, count } of productSkuCounts.values()) {
      if (count <= 1) {
        continue;
      }

      addFinding(pending, {
        severity: FindingSeverity.WARNING,
        category: FindingCategory.DUPLICATE_SKU,
        sku: displaySku,
        title: "Product export contains duplicate SKU rows",
        message: `${displaySku} appears ${count} times in ${file.originalFilename}.`,
        recommendedAction:
          "Confirm whether these are distinct variants or duplicate product-export rows before using SKU-level results.",
        source: {
          fileId: file.id,
          filename: file.originalFilename,
          stockyRowCount: count,
        },
      });
    }

    for (const purchaseOrder of openPurchaseOrders.values()) {
      const reference =
        purchaseOrder.reference ??
        `${file.originalFilename} row ${purchaseOrder.sourceRowNumbers[0]}`;
      const statuses = [...purchaseOrder.statuses].join(", ");
      const skuCount = purchaseOrder.skus.size;
      const handoffSummary =
        purchaseOrder.importReadyLineCount > 0
          ? ` ${purchaseOrder.importReadyLineCount} row${purchaseOrder.importReadyLineCount === 1 ? " is" : "s are"} eligible for a Shopify purchase-order import CSV after merchant verification.`
          : " No row has enough safe identity and quantity evidence for an import CSV.";
      const manualReviewSummary =
        purchaseOrder.manualReviewLineCount > 0
          ? ` ${purchaseOrder.manualReviewLineCount} row${purchaseOrder.manualReviewLineCount === 1 ? " needs" : "s need"} manual review.`
          : "";

      addFinding(pending, {
        severity: FindingSeverity.INFO,
        category: FindingCategory.OPEN_PURCHASE_ORDER_INDICATOR,
        sku: null,
        title: "Stocky purchase order may still need action",
        message: `${reference} has ${purchaseOrder.lineCount} preserved row${purchaseOrder.lineCount === 1 ? "" : "s"} with open-work status ${statuses}${skuCount > 0 ? ` across ${skuCount} SKU${skuCount === 1 ? "" : "s"}` : " and no usable SKU"}.${handoffSummary}${manualReviewSummary}`,
        recommendedAction:
          "Receive and close this order before cutover when possible. If it remains open, download the Open PO import files from Exports, verify the supplier, destination, costs, tax, and remaining quantities, then import each CSV into a Shopify draft purchase order. This recreates open work only; historical Stocky purchase orders cannot be imported as history.",
        source: {
          fileId: file.id,
          filename: file.originalFilename,
          reference: purchaseOrder.reference,
          affectedRowCount: purchaseOrder.lineCount,
          sourceRowNumbers: purchaseOrder.sourceRowNumbers,
          skus: [...purchaseOrder.skus],
          statuses: [...purchaseOrder.statuses],
          lineCount: purchaseOrder.lineCount,
          importReadyLineCount: purchaseOrder.importReadyLineCount,
          manualReviewLineCount: purchaseOrder.manualReviewLineCount,
          lineEvidence: purchaseOrder.lineEvidence,
        },
      });
    }
  }

  const findings = [...pending.values()];

  await db.$transaction(async (transaction) => {
    await transaction.auditFinding.deleteMany({
      where: { storeId, batchId },
    });

    if (findings.length > 0) {
      await transaction.auditFinding.createMany({
        data: findings.map((finding) => ({
          storeId,
          batchId,
          severity: finding.severity,
          category: finding.category,
          sku: finding.sku,
          title: finding.title,
          message: finding.message,
          recommendedAction: finding.recommendedAction,
          source: finding.source,
        })),
      });
    }

    await transaction.uploadBatch.update({
      where: { id: batchId },
      data: {
        auditSnapshotId: snapshot?.id ?? null,
        auditedAt: new Date(),
      },
    });
  });

  return { created: findings.length };
}

type ParsedRecordAuditPage = {
  id: string;
  sku: string | null;
  sourceRowNumber: number;
  normalizedPayload: Prisma.JsonValue;
  warnings: Prisma.JsonValue;
};

async function* iterateParsedRecords(
  uploadedFileId: string,
): AsyncGenerator<ParsedRecordAuditPage> {
  const pageSize = 500;
  let cursor: string | null = null;

  while (true) {
    const records: ParsedRecordAuditPage[] = await db.parsedRecord.findMany({
      where: { uploadedFileId },
      orderBy: [{ sourceRowNumber: "asc" }, { id: "asc" }],
      take: pageSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        sku: true,
        sourceRowNumber: true,
        normalizedPayload: true,
        warnings: true,
      },
    });

    for (const record of records) {
      yield record;
    }

    if (records.length < pageSize) {
      return;
    }

    cursor = records[records.length - 1].id;
  }
}

/*
 * Findings are deliberately aggregated before persistence. Historical Stocky
 * reports naturally repeat SKUs across purchase orders, stocktakes, and
 * activity rows; treating those repetitions as duplicate products creates
 * false urgency for merchants.
 */

function addFinding(
  findings: Map<string, PendingFinding>,
  finding: PendingFinding,
) {
  const key = [
    finding.category,
    finding.sku ?? "",
    finding.title,
    finding.message,
  ].join("|");

  if (!findings.has(key)) {
    findings.set(key, finding);
  }
}

function readPayload(value: Prisma.JsonValue): NormalizedPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as NormalizedPayload;
}

function readFileMetadata(
  value: Prisma.JsonValue | null | undefined,
): FileParseMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as FileParseMetadata;
}

function addFileMetadataFindings(
  findings: Map<string, PendingFinding>,
  fileId: string,
  filename: string,
  metadata: FileParseMetadata,
) {
  const unknownColumns = Array.isArray(metadata.unknownColumns)
    ? metadata.unknownColumns
    : [];
  const duplicateHeaders = Array.isArray(metadata.duplicateHeaders)
    ? metadata.duplicateHeaders
    : [];

  if (unknownColumns.length > 0) {
    addFinding(findings, {
      severity: FindingSeverity.INFO,
      category: FindingCategory.PARSE_ERROR,
      sku: null,
      title: "CSV contains unrecognized columns",
      message: `${filename}: ${unknownColumns.join(", ")}`,
      recommendedAction:
        "Download the preserved raw CSV if you need the original evidence. Unrecognized columns are preserved in parsed row payloads but are not used for matching.",
      source: {
        fileId,
        filename,
        unknownColumns,
      },
    });
  }

  if (duplicateHeaders.length > 0) {
    addFinding(findings, {
      severity: FindingSeverity.WARNING,
      category: FindingCategory.PARSE_ERROR,
      sku: null,
      title: "CSV contains duplicate header names",
      message: `${filename}: ${duplicateHeaders.join(", ")}. Values from every duplicate column were preserved, but duplicate labels can make a source export ambiguous.`,
      recommendedAction:
        "Confirm which duplicate column is authoritative before relying on normalized values. Download the preserved raw CSV to compare every original column.",
      source: {
        fileId,
        filename,
        duplicateHeaders,
      },
    });
  }
}

function readWarnings(value: Prisma.JsonValue) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parserWarningCopy(warning: string) {
  switch (warning) {
    case "column_count_mismatch":
      return {
        title: "CSV rows have a different column count",
        recommendedAction:
          "Compare the affected rows with the preserved raw CSV. Re-export the source report if values shifted into the wrong columns.",
      };
    case "invalid_cost":
      return {
        title: "Cost values could not be interpreted",
        recommendedAction:
          "Correct or confirm the affected Stocky cost values before using them as migration evidence.",
      };
    case "invalid_quantity":
      return {
        title: "Quantity values could not be interpreted",
        recommendedAction:
          "Correct or confirm the affected Stocky quantities before recreating purchasing or inventory work.",
      };
    case "invalid_date":
      return {
        title: "Date values could not be interpreted",
        recommendedAction:
          "Correct or confirm the affected Stocky dates before using them to plan cutover work.",
      };
    case "invalid_tax":
      return {
        title: "Tax values could not be interpreted",
        recommendedAction:
          "Correct or confirm the affected Stocky tax percentages before using an open purchase-order import file.",
      };
    default:
      return {
        title: "CSV rows need parser review",
        recommendedAction:
          "Compare the affected rows with the preserved raw CSV before relying on normalized values.",
      };
  }
}

function sourceFor(
  filename: string,
  sourceRowNumber: number,
  payload: NormalizedPayload,
) {
  return {
    filename,
    sourceRowNumber,
    normalized: payload.normalized ?? {},
  };
}
