import {
  ExportStatus,
  ExportType,
  FindingCategory,
  SyncStatus,
} from "@prisma/client";
import type { Prisma } from "@prisma/client";
import db from "../db.server";
import { toCsv } from "./csv.server";
import { readCatalogSummary } from "./catalog.server";

type NormalizedPayload = {
  sourceFilename?: string;
  raw?: Record<string, string>;
  normalized?: Record<string, string | null | undefined>;
};

const SKU_GAP_CATEGORIES = new Set<FindingCategory>([
  FindingCategory.MISSING_SKU,
  FindingCategory.UNMATCHED_SHOPIFY_SKU,
  FindingCategory.DUPLICATE_SKU,
  FindingCategory.MISSING_COST,
  FindingCategory.MISSING_BARCODE,
  FindingCategory.MISSING_VENDOR,
  FindingCategory.LOCATION_MISMATCH,
]);

export function isExportType(value: unknown): value is ExportType {
  return (
    typeof value === "string" &&
    Object.values(ExportType).includes(value as ExportType)
  );
}

export async function generateExport({
  storeId,
  batchId,
  exportType,
}: {
  storeId: string;
  batchId: string;
  exportType: ExportType;
}) {
  const job = await db.exportJob.create({
    data: {
      storeId,
      batchId,
      exportType,
      status: ExportStatus.RUNNING,
    },
  });

  try {
    const csv = await buildCsv({ storeId, batchId, exportType });
    const filename = `${exportType.toLowerCase()}-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;

    await db.exportJob.update({
      where: { id: job.id },
      data: {
        status: ExportStatus.SUCCEEDED,
        generatedFilePointer: `/app/exports/${exportType}?batch=${encodeURIComponent(batchId)}`,
        completedAt: new Date(),
      },
    });

    return {
      body: csv,
      filename,
      contentType: "text/csv; charset=utf-8",
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown export failure.";

    await db.exportJob.update({
      where: { id: job.id },
      data: {
        status: ExportStatus.FAILED,
        errorMessage: message,
      },
    });

    throw error;
  }
}

async function buildCsv({
  storeId,
  batchId,
  exportType,
}: {
  storeId: string;
  batchId: string;
  exportType: ExportType;
}) {
  if (exportType === ExportType.ARCHIVE_CSV) {
    return buildArchiveCsv(storeId, batchId);
  }

  if (exportType === ExportType.SKU_GAP_REPORT) {
    return buildSkuGapCsv(storeId, batchId);
  }

  if (exportType === ExportType.SUPPLIER_RECONSTRUCTION_REPORT) {
    return buildSupplierCsv(storeId, batchId);
  }

  return buildMigrationChecklistCsv(storeId, batchId);
}

async function buildArchiveCsv(storeId: string, batchId: string) {
  const records = await db.parsedRecord.findMany({
    where: {
      uploadedFile: {
        batch: {
          storeId,
          id: batchId,
        },
      },
    },
    orderBy: [{ uploadedFileId: "asc" }, { sourceRowNumber: "asc" }],
    include: {
      uploadedFile: true,
    },
  });

  return toCsv([
    [
      "file",
      "file_sha256",
      "raw_storage_pointer",
      "raw_byte_length",
      "report_type",
      "source_row",
      "sku",
      "normalized_json",
      "raw_json",
      "warnings",
    ],
    ...records.map((record) => {
      const payload = readPayload(record.normalizedPayload);

      return [
        record.uploadedFile.originalFilename,
        record.uploadedFile.contentSha256 ?? "",
        record.uploadedFile.storagePointer,
        String(record.uploadedFile.rawContentByteLength ?? ""),
        record.normalizedType,
        String(record.sourceRowNumber),
        record.sku ?? "",
        JSON.stringify(payload.normalized ?? {}),
        JSON.stringify(payload.raw ?? {}),
        JSON.stringify(record.warnings ?? []),
      ];
    }),
  ]);
}

async function buildSkuGapCsv(storeId: string, batchId: string) {
  const findings = await db.auditFinding.findMany({
    where: {
      storeId,
      batchId,
      category: {
        in: [...SKU_GAP_CATEGORIES],
      },
    },
    orderBy: [{ severity: "asc" }, { category: "asc" }, { sku: "asc" }],
  });

  return toCsv([
    [
      "severity",
      "category",
      "sku",
      "title",
      "message",
      "recommended_action",
      "created_at",
    ],
    ...findings.map((finding) => [
      finding.severity,
      finding.category,
      finding.sku ?? "",
      finding.title,
      finding.message,
      finding.recommendedAction,
      finding.createdAt.toISOString(),
    ]),
  ]);
}

async function buildSupplierCsv(storeId: string, batchId: string) {
  const records = await db.parsedRecord.findMany({
    where: {
      uploadedFile: {
        batch: {
          storeId,
          id: batchId,
        },
      },
    },
    orderBy: [{ sku: "asc" }, { sourceRowNumber: "asc" }],
    include: {
      uploadedFile: true,
    },
  });

  const rows = records
    .map((record) => {
      const payload = readPayload(record.normalizedPayload);
      const normalized = payload.normalized ?? {};
      const supplier = normalized.supplier ?? normalized.vendor ?? "";

      return {
        file: record.uploadedFile.originalFilename,
        row: record.sourceRowNumber,
        sku: record.sku ?? normalized.sku ?? "",
        title: normalized.title ?? "",
        supplier,
        vendor: normalized.vendor ?? "",
        reference: normalized.reference ?? "",
      };
    })
    .filter((row) => row.supplier);

  return toCsv([
    [
      "sku",
      "title",
      "supplier_hint",
      "vendor_hint",
      "source_file",
      "source_row",
      "stocky_reference",
      "recommended_action",
    ],
    ...rows.map((row) => [
      row.sku,
      row.title,
      row.supplier,
      row.vendor,
      row.file,
      String(row.row),
      row.reference,
      "Use as evidence when reconstructing supplier records outside Shopify.",
    ]),
  ]);
}

async function buildMigrationChecklistCsv(storeId: string, batchId: string) {
  const [
    recordCount,
    latestSnapshot,
    criticalCount,
    warningCount,
    openPoCount,
  ] = await Promise.all([
    db.parsedRecord.count({
      where: {
        uploadedFile: {
          batch: {
            storeId,
            id: batchId,
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
    db.auditFinding.count({
      where: {
        storeId,
        batchId,
        severity: "CRITICAL",
      },
    }),
    db.auditFinding.count({
      where: {
        storeId,
        batchId,
        severity: "WARNING",
      },
    }),
    db.auditFinding.count({
      where: {
        storeId,
        batchId,
        category: FindingCategory.OPEN_PURCHASE_ORDER_INDICATOR,
      },
    }),
  ]);
  const summary = readCatalogSummary(latestSnapshot?.summary ?? null);

  return toCsv([
    ["item", "status", "evidence", "next_action"],
    [
      "Upload Stocky CSV exports",
      recordCount > 0 ? "done" : "needed",
      `${recordCount} parsed rows`,
      "Upload purchase order, stocktake, cost, inventory activity, product, and vendor CSV exports.",
    ],
    [
      "Sync Shopify catalog",
      latestSnapshot ? "done" : "needed",
      latestSnapshot
        ? `${latestSnapshot.variantCount} variants, ${latestSnapshot.locationCount} locations`
        : "No successful sync",
      "Run catalog sync from the embedded app using read-only GraphQL access.",
    ],
    [
      "Resolve critical SKU issues",
      criticalCount === 0 ? "ready" : "needs_attention",
      `${criticalCount} critical findings`,
      "Resolve missing and unmatched SKUs before relying on migration reports.",
    ],
    [
      "Review product metadata gaps",
      warningCount === 0 ? "ready" : "needs_attention",
      `${warningCount} warning findings`,
      "Review duplicate SKUs, missing cost, barcode, vendor, and location mismatches.",
    ],
    [
      "Review open Stocky purchase orders",
      openPoCount === 0 ? "ready" : "manual_review",
      `${openPoCount} open purchase order indicators`,
      "Review manually. Historical Stocky purchase orders cannot be imported into Shopify.",
    ],
    [
      "Check catalog sync completeness",
      summary?.truncated ? "needs_attention" : "ready",
      summary?.truncated
        ? `Sync reached configured limit of ${summary.limit} variants`
        : "Catalog sync was not truncated",
      "Increase SHOPIFY_SYNC_VARIANT_LIMIT or move sync to a background bulk job for larger catalogs.",
    ],
  ]);
}

function readPayload(value: Prisma.JsonValue): NormalizedPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as NormalizedPayload;
}
