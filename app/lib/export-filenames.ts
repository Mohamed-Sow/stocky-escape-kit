import { ExportType } from "@prisma/client";

const EXPORT_FILENAME_STEMS: Record<ExportType, string> = {
  ARCHIVE_CSV: "parsed-archive",
  SKU_GAP_REPORT: "audit-findings",
  SUPPLIER_RECONSTRUCTION_REPORT: "supplier-evidence",
  MIGRATION_CHECKLIST: "migration-checklist",
};

export function formatRunFilenameStamp(createdAt: Date) {
  return createdAt.toISOString().replace(/[-:.]/g, "");
}

export function getExportFilename(exportType: ExportType, runCreatedAt: Date) {
  return `stocky-${EXPORT_FILENAME_STEMS[exportType]}-run-${formatRunFilenameStamp(runCreatedAt)}.csv`;
}

export function getReviewKitFilename(runCreatedAt: Date) {
  return `stocky-migration-package-run-${formatRunFilenameStamp(runCreatedAt)}.zip`;
}
