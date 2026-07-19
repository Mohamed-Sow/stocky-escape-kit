import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  FileParseStatus,
  StockyReportType,
  UploadBatchStatus,
} from "@prisma/client";
import type { Prisma } from "@prisma/client";
import db from "../db.server";
import { regenerateAuditFindings } from "./audit.server";
import {
  getPlanEntitlements,
  validateUploadFiles,
  type PlanEntitlements,
} from "./entitlements.server";
import { parseStockyCsv } from "./stocky-parser.server";
import { decodeStockyCsvBytes } from "./text-decoding.server";

export type UploadImportResult = {
  batchId: string;
  fileCount: number;
  importedRowCount: number;
  warningCount: number;
  failedFileCount: number;
};

export async function importStockyCsvFiles({
  storeId,
  files,
  entitlements = getPlanEntitlements("review"),
  currentStoredBytes = 0,
  includeLocationMismatches = true,
}: {
  storeId: string;
  files: File[];
  entitlements?: PlanEntitlements;
  currentStoredBytes?: number;
  includeLocationMismatches?: boolean;
}): Promise<UploadImportResult> {
  validateUploadFiles({ files, entitlements, currentStoredBytes });

  const batch = await db.uploadBatch.create({
    data: {
      storeId,
      status: UploadBatchStatus.IMPORTING,
      fileCount: files.length,
    },
  });

  let importedRowCount = 0;
  let warningCount = 0;
  let failedFileCount = 0;
  let parsedFileCount = 0;

  try {
    for (const file of files) {
      if (!isCsvFile(file)) {
        failedFileCount += 1;
        warningCount += 1;

        await db.uploadedFile.create({
          data: {
            batchId: batch.id,
            originalFilename: file.name || "unnamed-file",
            detectedReportType: StockyReportType.UNKNOWN,
            parseStatus: FileParseStatus.FAILED,
            storagePointer: "rejected:non-csv",
            errorMessage: "Only CSV files can be uploaded.",
            warningCount: 1,
          },
        });

        continue;
      }

      const rawContent = Buffer.from(await file.arrayBuffer());
      const decoded = decodeStockyCsvBytes(rawContent);
      const contentSha256 = createHash("sha256")
        .update(rawContent)
        .digest("hex");
      const parsed = parseStockyCsv({
        filename: file.name || "stocky-export.csv",
        content: decoded.content,
        sourceEncoding: decoded.encoding,
      });
      const rowLimitExceeded = parsed.rowCount > entitlements.maxRowsPerFile;
      const batchRowLimitExceeded =
        !rowLimitExceeded &&
        importedRowCount + parsed.rowCount > entitlements.maxRowsPerBatch;
      const failed =
        parsed.parseErrors.length > 0 ||
        rowLimitExceeded ||
        batchRowLimitExceeded;
      const fileWarningCount =
        parsed.warningCount +
        (rowLimitExceeded ? 1 : 0) +
        (batchRowLimitExceeded ? 1 : 0);
      const errorMessage = [
        ...parsed.parseErrors,
        ...(rowLimitExceeded
          ? [
              `${parsed.rowCount.toLocaleString()} rows exceeds the ${entitlements.maxRowsPerFile.toLocaleString()} row limit per file for ${entitlements.label}.`,
            ]
          : []),
        ...(batchRowLimitExceeded
          ? [
              `Adding ${parsed.rowCount.toLocaleString()} rows would exceed the ${entitlements.maxRowsPerBatch.toLocaleString()} parsed-row limit for one ${entitlements.label} migration run. Start a separate run for this file.`,
            ]
          : []),
      ].join("; ");

      if (failed) {
        failedFileCount += 1;
      } else {
        parsedFileCount += 1;
        importedRowCount += parsed.rowCount;
      }

      warningCount += fileWarningCount;

      const uploadedFile = await db.uploadedFile.create({
        data: {
          batchId: batch.id,
          originalFilename: file.name || "stocky-export.csv",
          detectedReportType: parsed.reportType,
          parseStatus: failed ? FileParseStatus.FAILED : FileParseStatus.PARSED,
          storagePointer: `db:uploaded_file.rawContentBase64:sha256:${contentSha256}`,
          contentSha256,
          rawContentBase64: rawContent.toString("base64"),
          rawContentByteLength: rawContent.byteLength,
          parseMetadata: parsed.metadata,
          rowCount: failed ? 0 : parsed.rowCount,
          warningCount: fileWarningCount,
          errorMessage: failed ? errorMessage : null,
        },
      });

      if (!failed && parsed.records.length > 0) {
        const records = parsed.records.map((record) => ({
          uploadedFileId: uploadedFile.id,
          normalizedType: parsed.reportType,
          sourceRowNumber: record.sourceRowNumber,
          sku: record.sku,
          normalizedPayload: record.normalizedPayload,
          warnings: record.warnings as Prisma.InputJsonArray,
        }));

        for (let index = 0; index < records.length; index += 500) {
          await db.parsedRecord.createMany({
            data: records.slice(index, index + 500),
          });
        }
      }
    }

    const status =
      parsedFileCount > 0
        ? UploadBatchStatus.IMPORTED
        : UploadBatchStatus.FAILED;

    await db.uploadBatch.update({
      where: { id: batch.id },
      data: {
        status,
        importedRowCount,
        warningCount,
      },
    });

    await regenerateAuditFindings({
      storeId,
      batchId: batch.id,
      snapshotId: null,
      includeLocationMismatches,
    });

    return {
      batchId: batch.id,
      fileCount: files.length,
      importedRowCount,
      warningCount,
      failedFileCount,
    };
  } catch (error) {
    await db.uploadBatch.update({
      where: { id: batch.id },
      data: {
        status: UploadBatchStatus.FAILED,
        importedRowCount,
        warningCount: warningCount + 1,
      },
    });

    throw error;
  }
}

function isCsvFile(file: File) {
  const name = file.name.toLowerCase();

  return (
    name.endsWith(".csv") ||
    file.type === "text/csv" ||
    file.type === "application/vnd.ms-excel" ||
    file.type === "text/plain" ||
    file.type === ""
  );
}
