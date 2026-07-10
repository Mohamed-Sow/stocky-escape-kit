import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { ExportType } from "@prisma/client";
import { strToU8, zipSync } from "fflate";
import { generateExport } from "./exports.server";

export async function generateReviewKit({
  storeId,
  batchId,
}: {
  storeId: string;
  batchId: string;
}) {
  const reports = await Promise.all(
    Object.values(ExportType).map((exportType) =>
      generateExport({ storeId, batchId, exportType }),
    ),
  );
  const entries: Record<string, Uint8Array> = {};
  const manifest = reports.map((report) => {
    const bytes = Buffer.from(report.body, "utf8");
    entries[report.filename] = new Uint8Array(bytes);

    return {
      filename: report.filename,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });

  const manifestBody = `${JSON.stringify(
    {
      format: "Stocky Escape Kit review kit",
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
