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
import { parseStockyCsv } from "./stocky-parser.server";

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
}: {
  storeId: string;
  files: File[];
}): Promise<UploadImportResult> {
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
    const content = rawContent.toString("utf8");
    const contentSha256 = createHash("sha256")
      .update(rawContent)
      .digest("hex");
    const parsed = parseStockyCsv({
      filename: file.name || "stocky-export.csv",
      content,
    });
    const failed = parsed.parseErrors.length > 0;

    if (failed) {
      failedFileCount += 1;
    } else {
      importedRowCount += parsed.rowCount;
    }

    warningCount += parsed.warningCount;

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
        rowCount: failed ? 0 : parsed.rowCount,
        warningCount: parsed.warningCount,
        errorMessage: failed ? parsed.parseErrors.join("; ") : null,
      },
    });

    if (!failed && parsed.records.length > 0) {
      await db.parsedRecord.createMany({
        data: parsed.records.map((record) => ({
          uploadedFileId: uploadedFile.id,
          normalizedType: parsed.reportType,
          sourceRowNumber: record.sourceRowNumber,
          sku: record.sku,
          normalizedPayload: record.normalizedPayload,
          warnings: record.warnings as Prisma.InputJsonArray,
        })),
      });
    }
  }

  const status =
    importedRowCount > 0
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
  });

  return {
    batchId: batch.id,
    fileCount: files.length,
    importedRowCount,
    warningCount,
    failedFileCount,
  };
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
