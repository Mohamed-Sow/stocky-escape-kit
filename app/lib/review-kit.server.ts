import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { ExportType } from "@prisma/client";
import { strToU8, zipSync } from "fflate";
import db from "../db.server";
import { generateExport, type ExportGenerationOptions } from "./exports.server";
import { safeDownloadFilename } from "./filenames.server";

export async function generateReviewKit({
  storeId,
  batchId,
  options = {},
}: {
  storeId: string;
  batchId: string;
  options?: ExportGenerationOptions;
}) {
  const entries: Record<string, Uint8Array> = {};
  const manifest: Array<{
    kind: "report" | "source";
    filename: string;
    bytes: number;
    sha256: string;
  }> = [];

  for (const exportType of Object.values(ExportType)) {
    const report = await generateExport({
      storeId,
      batchId,
      exportType,
      options,
    });
    const bytes = Buffer.from(report.body, "utf8");
    entries[report.filename] = new Uint8Array(bytes);

    manifest.push({
      kind: "report",
      filename: report.filename,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }

  const sourceFiles = await db.uploadedFile.findMany({
    where: {
      batch: {
        id: batchId,
        storeId,
      },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      originalFilename: true,
      contentSha256: true,
    },
  });

  for (const [index, source] of sourceFiles.entries()) {
    const preserved = await db.uploadedFile.findFirst({
      where: {
        id: source.id,
        batch: { id: batchId, storeId },
      },
      select: { rawContentBase64: true },
    });

    if (!preserved?.rawContentBase64) continue;
    const bytes = Buffer.from(preserved.rawContentBase64, "base64");
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    if (source.contentSha256 && source.contentSha256 !== sha256) {
      throw new Error(
        `Preserved source checksum mismatch for ${source.originalFilename}.`,
      );
    }

    const filename = `source/${String(index + 1).padStart(2, "0")}-${safeDownloadFilename(source.originalFilename)}`;
    entries[filename] = new Uint8Array(bytes);
    manifest.push({
      kind: "source",
      filename,
      bytes: bytes.byteLength,
      sha256,
    });
  }

  const manifestBody = `${JSON.stringify(
    {
      format: "Stocky Escape Kit migration record",
      batchId,
      generatedAt: new Date().toISOString(),
      files: manifest,
    },
    null,
    2,
  )}\n`;
  entries["manifest.json"] = strToU8(manifestBody);

  return {
    bytes: zipSync(entries, { level: 6 }),
    filename: `stocky-review-kit-${new Date().toISOString().slice(0, 10)}.zip`,
    manifest,
  };
}
