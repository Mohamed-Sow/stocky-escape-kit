import {
  ExportStatus,
  ExportType,
  FindingCategory,
  StockyReportType,
  SyncStatus,
} from "@prisma/client";
import type { Prisma } from "@prisma/client";
import db from "../db.server";
import { toCsv } from "./csv.server";

type NormalizedPayload = {
  sourceFilename?: string;
  raw?: Record<string, string>;
  normalized?: Record<string, string | null | undefined>;
};

export type ExportGenerationOptions = {
  priorityChecklist?: boolean;
  includeLocationMismatches?: boolean;
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

const EXPORT_PAGE_SIZE = 500;

const ARCHIVE_RECORD_SELECT = {
  id: true,
  normalizedType: true,
  sourceRowNumber: true,
  sku: true,
  normalizedPayload: true,
  warnings: true,
  uploadedFile: {
    select: {
      originalFilename: true,
      contentSha256: true,
      storagePointer: true,
      rawContentByteLength: true,
    },
  },
} satisfies Prisma.ParsedRecordSelect;

type ArchiveExportRecord = Prisma.ParsedRecordGetPayload<{
  select: typeof ARCHIVE_RECORD_SELECT;
}>;

const SUPPLIER_RECORD_SELECT = {
  id: true,
  sourceRowNumber: true,
  sku: true,
  normalizedPayload: true,
  uploadedFile: {
    select: { originalFilename: true },
  },
} satisfies Prisma.ParsedRecordSelect;

type SupplierExportRecord = Prisma.ParsedRecordGetPayload<{
  select: typeof SUPPLIER_RECORD_SELECT;
}>;

const SKU_GAP_FINDING_SELECT = {
  id: true,
  severity: true,
  category: true,
  sku: true,
  title: true,
  message: true,
  recommendedAction: true,
  createdAt: true,
} satisfies Prisma.AuditFindingSelect;

type SkuGapExportFinding = Prisma.AuditFindingGetPayload<{
  select: typeof SKU_GAP_FINDING_SELECT;
}>;

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
  options = {},
}: {
  storeId: string;
  batchId: string;
  exportType: ExportType;
  options?: ExportGenerationOptions;
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
    const csv = await buildCsv({ storeId, batchId, exportType, options });
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
  options,
}: {
  storeId: string;
  batchId: string;
  exportType: ExportType;
  options: ExportGenerationOptions;
}) {
  if (exportType === ExportType.ARCHIVE_CSV) {
    return buildArchiveCsv(storeId, batchId);
  }

  if (exportType === ExportType.SKU_GAP_REPORT) {
    return buildSkuGapCsv(storeId, batchId, options);
  }

  if (exportType === ExportType.SUPPLIER_RECONSTRUCTION_REPORT) {
    return buildSupplierCsv(storeId, batchId);
  }

  return buildMigrationChecklistCsv(storeId, batchId, options);
}

async function buildArchiveCsv(storeId: string, batchId: string) {
  const chunks = [
    toCsv([
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
    ]),
  ];
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const records: ArchiveExportRecord[] = await db.parsedRecord.findMany({
      where: {
        uploadedFile: {
          batch: {
            storeId,
            id: batchId,
          },
        },
      },
      orderBy: [
        { uploadedFileId: "asc" },
        { sourceRowNumber: "asc" },
        { id: "asc" },
      ],
      take: EXPORT_PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: ARCHIVE_RECORD_SELECT,
    });

    if (records.length === 0) {
      hasMore = false;
      continue;
    }

    chunks.push(
      toCsv(
        records.map((record) => {
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
      ),
    );

    hasMore = records.length === EXPORT_PAGE_SIZE;
    cursor = hasMore ? records[records.length - 1].id : null;
  }

  return chunks.join("\n");
}

async function buildSkuGapCsv(
  storeId: string,
  batchId: string,
  options: ExportGenerationOptions,
) {
  const categories = [...SKU_GAP_CATEGORIES].filter(
    (category) =>
      options.includeLocationMismatches !== false ||
      category !== FindingCategory.LOCATION_MISMATCH,
  );
  const chunks = [
    toCsv([
      [
        "severity",
        "category",
        "sku",
        "title",
        "message",
        "recommended_action",
        "created_at",
      ],
    ]),
  ];
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const findings: SkuGapExportFinding[] = await db.auditFinding.findMany({
      where: {
        storeId,
        batchId,
        category: {
          in: categories,
        },
      },
      orderBy: [
        { severity: "asc" },
        { category: "asc" },
        { sku: "asc" },
        { id: "asc" },
      ],
      take: EXPORT_PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: SKU_GAP_FINDING_SELECT,
    });

    if (findings.length === 0) {
      hasMore = false;
      continue;
    }

    chunks.push(
      toCsv(
        findings.map((finding) => [
          finding.severity,
          finding.category,
          finding.sku ?? "",
          finding.title,
          finding.message,
          finding.recommendedAction,
          finding.createdAt.toISOString(),
        ]),
      ),
    );

    hasMore = findings.length === EXPORT_PAGE_SIZE;
    cursor = hasMore ? findings[findings.length - 1].id : null;
  }

  return chunks.join("\n");
}

async function buildSupplierCsv(storeId: string, batchId: string) {
  const chunks = [
    toCsv([
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
    ]),
  ];
  let cursor: string | null = null;
  let hasMore = true;

  while (hasMore) {
    const records: SupplierExportRecord[] = await db.parsedRecord.findMany({
      where: {
        uploadedFile: {
          batch: {
            storeId,
            id: batchId,
          },
        },
      },
      orderBy: [{ sku: "asc" }, { sourceRowNumber: "asc" }, { id: "asc" }],
      take: EXPORT_PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: SUPPLIER_RECORD_SELECT,
    });

    if (records.length === 0) {
      hasMore = false;
      continue;
    }

    const rows = records
      .map((record) => {
        const payload = readPayload(record.normalizedPayload);
        const normalized = payload.normalized ?? {};
        const supplier = normalized.supplier ?? "";
        const vendor = normalized.vendor ?? "";

        return {
          file: record.uploadedFile.originalFilename,
          row: record.sourceRowNumber,
          sku: record.sku ?? normalized.sku ?? "",
          title: normalized.title ?? "",
          supplier,
          vendor,
          reference: normalized.reference ?? "",
        };
      })
      .filter((row) => row.supplier || row.vendor);

    if (rows.length > 0) {
      chunks.push(
        toCsv(
          rows.map((row) => [
            row.sku,
            row.title,
            row.supplier,
            row.vendor,
            row.file,
            String(row.row),
            row.reference,
            row.supplier
              ? "Use as evidence when recreating suppliers in Shopify. Supplier records cannot be exported directly from Stocky."
              : "Vendor-only lead: confirm against purchase orders or custom SKU reports before recreating a supplier.",
          ]),
        ),
      );
    }

    hasMore = records.length === EXPORT_PAGE_SIZE;
    cursor = hasMore ? records[records.length - 1].id : null;
  }

  return chunks.join("\n");
}

async function buildMigrationChecklistCsv(
  storeId: string,
  batchId: string,
  options: ExportGenerationOptions,
) {
  const findingWhere: Prisma.AuditFindingWhereInput = {
    storeId,
    batchId,
    category:
      options.includeLocationMismatches === false
        ? { not: FindingCategory.LOCATION_MISMATCH }
        : undefined,
  };
  const [recordCount, reportTypeRows, batch, findingGroups] = await Promise.all(
    [
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
      db.parsedRecord.findMany({
        where: {
          uploadedFile: {
            batch: {
              storeId,
              id: batchId,
            },
          },
        },
        distinct: ["normalizedType"],
        select: { normalizedType: true },
      }),
      db.uploadBatch.findFirst({
        where: { id: batchId, storeId },
        include: {
          auditSnapshot: {
            select: {
              syncStatus: true,
              variantCount: true,
              locationCount: true,
            },
          },
        },
      }),
      db.auditFinding.groupBy({
        by: ["severity", "category"],
        where: findingWhere,
        _count: { _all: true },
      }),
    ],
  );
  const latestSnapshot =
    batch?.auditSnapshot?.syncStatus === SyncStatus.SUCCEEDED
      ? batch.auditSnapshot
      : null;
  const reportTypes = new Set(
    reportTypeRows.map((record) => record.normalizedType),
  );
  const countFindings = ({
    severity,
    category,
  }: {
    severity?: string;
    category?: FindingCategory;
  }) =>
    findingGroups.reduce(
      (count, group) =>
        count +
        ((!severity || group.severity === severity) &&
        (!category || group.category === category)
          ? group._count._all
          : 0),
      0,
    );
  const criticalCount = countFindings({ severity: "CRITICAL" });
  const warningCount = countFindings({ severity: "WARNING" });
  const openPoCount = countFindings({
    category: FindingCategory.OPEN_PURCHASE_ORDER_INDICATOR,
  });
  const supplierEvidenceCount = countFindings({
    category: FindingCategory.SUPPLIER_RECONSTRUCTION_CANDIDATE,
  });
  const rows = [
    [
      "high",
      "Upload Stocky CSV exports",
      recordCount > 0 ? "done" : "needed",
      `${recordCount} parsed rows`,
      "Preserve product or custom SKU reports, purchase orders, stocktakes, historical cost, and inventory activity CSVs.",
    ],
    [
      "high",
      "Confirm source report coverage",
      [
        StockyReportType.PRODUCTS,
        StockyReportType.PURCHASE_ORDERS,
        StockyReportType.STOCKTAKES,
        StockyReportType.HISTORICAL_COSTS,
        StockyReportType.INVENTORY_ACTIVITY,
      ].every((type) => reportTypes.has(type))
        ? "done"
        : "needs_attention",
      [...reportTypes].sort().join(", ") || "No parsed report types",
      "Return to Stocky and export any missing historical report categories before read-only export access expires.",
    ],
    [
      "high",
      "Sync Shopify catalog",
      latestSnapshot ? "done" : "needed",
      latestSnapshot
        ? `${latestSnapshot.variantCount} variants, ${latestSnapshot.locationCount} locations`
        : "No successful sync",
      "Run catalog sync from the embedded app using read-only GraphQL access.",
    ],
    [
      "high",
      "Resolve critical SKU issues",
      criticalCount === 0 ? "ready" : "needs_attention",
      `${criticalCount} critical findings`,
      "Resolve missing and unmatched SKUs before relying on migration reports.",
    ],
    [
      "medium",
      "Review product metadata gaps",
      warningCount === 0 ? "ready" : "needs_attention",
      `${warningCount} warning findings`,
      "Review duplicate SKUs, missing cost, barcode, vendor, and location mismatches.",
    ],
    [
      "high",
      "Review open Stocky purchase orders",
      openPoCount === 0 ? "ready" : "manual_review",
      `${openPoCount} open purchase order indicators`,
      "Receive and close each order before cutover when possible. If one remains open, recreate only its remaining quantities in Shopify; historical Stocky purchase orders cannot be imported into Shopify.",
    ],
    [
      "medium",
      "Rebuild supplier records",
      supplierEvidenceCount > 0 ? "manual_review" : "needs_attention",
      `${supplierEvidenceCount} supplier evidence finding${supplierEvidenceCount === 1 ? "" : "s"}`,
      "Use explicit supplier evidence first and verify vendor-only leads against purchase orders or custom SKU reports. Stocky supplier records cannot be exported directly.",
    ],
    [
      "high",
      "Set the purchasing cutover",
      "manual_action",
      "Shopify recommends stopping new Stocky purchase orders about 14 days before August 31, 2026",
      "Choose an owner and cutover date, tell purchasing staff, and move new purchasing work to Shopify.",
    ],
    [
      "high",
      "Test Shopify replacement workflows",
      "manual_action",
      "A read-only catalog audit cannot verify staff workflow readiness",
      "Complete a test purchase order, transfer, and inventory adjustment in Shopify. Test the Shopify POS path too if staff use it.",
    ],
    [
      "medium",
      "Train staff and remove the Stocky POS tile",
      "manual_action",
      "Team readiness is outside the uploaded CSV evidence",
      "Train everyone responsible for inventory and remove Stocky's Transfers tile from the Shopify POS Smart Grid when the replacement process is ready.",
    ],
    [
      "medium",
      "Update Stocky-dependent integrations",
      "manual_action",
      "Stocky APIs stop working on August 31, 2026",
      "Identify every ERP, warehouse, reporting, or automation integration that calls Stocky and move it to a supported Shopify workflow before shutdown.",
    ],
    [
      "low",
      "Preserve the final handoff",
      criticalCount === 0 && latestSnapshot ? "ready" : "not_ready",
      `${criticalCount} critical and ${warningCount} warning findings remain`,
      "Download the raw source files and available reports, then retain their checksums with the migration record.",
    ],
  ];
  const table = options.priorityChecklist
    ? [["priority", "item", "status", "evidence", "next_action"], ...rows]
    : [
        ["item", "status", "evidence", "next_action"],
        ...rows.map(([, ...row]) => row),
      ];

  return toCsv(table);
}

function readPayload(value: Prisma.JsonValue): NormalizedPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as NormalizedPayload;
}
