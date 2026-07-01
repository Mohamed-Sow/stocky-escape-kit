import {
  FindingCategory,
  FindingSeverity,
  StockyReportType,
  SyncStatus,
} from "@prisma/client";
import type { Prisma } from "@prisma/client";
import db from "../db.server";
import { readCatalogSummary, type CatalogVariant } from "./catalog.server";

type NormalizedPayload = {
  sourceFilename?: string;
  reportType?: StockyReportType;
  raw?: Record<string, string>;
  normalized?: {
    sku?: string | null;
    title?: string | null;
    barcode?: string | null;
    vendor?: string | null;
    supplier?: string | null;
    location?: string | null;
    cost?: string | null;
    quantity?: string | null;
    status?: string | null;
    date?: string | null;
    reference?: string | null;
  };
  meta?: {
    unknownColumns?: string[];
  };
};

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
}: {
  storeId: string;
  batchId: string;
}) {
  await db.auditFinding.deleteMany({
    where: {
      storeId,
      batchId,
    },
  });

  const [batch, snapshot] = await Promise.all([
    db.uploadBatch.findUnique({
      where: { id: batchId },
      include: {
        uploadedFiles: {
          include: {
            parsedRecords: true,
          },
        },
      },
    }),
    db.shopifyCatalogSnapshot.findFirst({
      where: {
        storeId,
        syncStatus: SyncStatus.SUCCEEDED,
      },
      orderBy: { syncedAt: "desc" },
    }),
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
  const stockySkuCounts = new Map<string, number>();

  for (const file of batch.uploadedFiles) {
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

    const unknownColumns = readUnknownColumns(
      file.parsedRecords[0]?.normalizedPayload,
    );

    if (unknownColumns.length > 0) {
      addFinding(pending, {
        severity: FindingSeverity.INFO,
        category: FindingCategory.PARSE_ERROR,
        sku: null,
        title: "CSV contains unrecognized columns",
        message: `${file.originalFilename}: ${unknownColumns.join(", ")}`,
        recommendedAction:
          "Keep the original CSV in the archive. Unrecognized columns are preserved in row payloads but are not used for matching.",
        source: {
          fileId: file.id,
          filename: file.originalFilename,
          unknownColumns,
        },
      });
    }

    for (const record of file.parsedRecords) {
      const payload = readPayload(record.normalizedPayload);
      const normalized = payload.normalized ?? {};
      const sku = record.sku?.trim() || normalized.sku?.trim() || null;

      if (sku) {
        const key = sku.toLowerCase();
        stockySkuCounts.set(key, (stockySkuCounts.get(key) ?? 0) + 1);
      }

      if (!sku) {
        addFinding(pending, {
          severity: FindingSeverity.CRITICAL,
          category: FindingCategory.MISSING_SKU,
          sku: null,
          title: "Stocky row has no SKU",
          message: `${file.originalFilename} row ${record.sourceRowNumber} cannot be matched to Shopify without a SKU.`,
          recommendedAction:
            "Add or recover the SKU in the source export before relying on this row for migration decisions.",
          source: sourceFor(
            file.originalFilename,
            record.sourceRowNumber,
            payload,
          ),
        });
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
            "Resolve duplicate Shopify SKUs before importing or reconciling Stocky history.",
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
              "Add product cost in Shopify or verify the app reviewer has product cost visibility.",
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

      if (
        file.detectedReportType === StockyReportType.PURCHASE_ORDERS &&
        isOpenPurchaseOrderStatus(normalized.status)
      ) {
        addFinding(pending, {
          severity: FindingSeverity.INFO,
          category: FindingCategory.OPEN_PURCHASE_ORDER_INDICATOR,
          sku,
          title: "Stocky row may represent open purchasing work",
          message: `${sku} has Stocky purchase order status ${normalized.status ?? "unknown"}.`,
          recommendedAction:
            "Review this purchase order manually. Historical Stocky purchase orders cannot be imported into Shopify.",
          source: sourceFor(
            file.originalFilename,
            record.sourceRowNumber,
            payload,
          ),
        });
      }

      if (normalized.supplier || normalized.vendor) {
        addFinding(pending, {
          severity: FindingSeverity.INFO,
          category: FindingCategory.SUPPLIER_RECONSTRUCTION_CANDIDATE,
          sku,
          title: "Supplier hint available from Stocky export",
          message: `${sku} has supplier evidence from ${normalized.supplier ?? normalized.vendor}.`,
          recommendedAction:
            "Use this row as evidence when reconstructing supplier records outside Shopify.",
          source: sourceFor(
            file.originalFilename,
            record.sourceRowNumber,
            payload,
          ),
        });
      }
    }
  }

  for (const [sku, count] of stockySkuCounts.entries()) {
    if (count <= 1) {
      continue;
    }

    addFinding(pending, {
      severity: FindingSeverity.WARNING,
      category: FindingCategory.DUPLICATE_SKU,
      sku,
      title: "Stocky exports contain duplicate SKU rows",
      message: `${sku} appears ${count} times in the uploaded Stocky batch.`,
      recommendedAction:
        "Confirm whether these rows represent distinct locations, variants, or duplicate export rows.",
      source: {
        stockyRowCount: count,
      },
    });
  }

  const findings = [...pending.values()];

  if (findings.length === 0) {
    return { created: 0 };
  }

  await db.auditFinding.createMany({
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

  return { created: findings.length };
}

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

function readUnknownColumns(value: Prisma.JsonValue | undefined) {
  if (!value) {
    return [];
  }

  const payload = readPayload(value);
  return Array.isArray(payload.meta?.unknownColumns)
    ? payload.meta.unknownColumns
    : [];
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

function isOpenPurchaseOrderStatus(status: string | null | undefined) {
  if (!status) {
    return false;
  }

  const value = status.toLowerCase();

  return ["open", "pending", "partial", "ordered", "unreceived"].some(
    (openStatus) => value.includes(openStatus),
  );
}
