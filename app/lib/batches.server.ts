import type { Prisma } from "@prisma/client";
import db from "../db.server";

export const uploadBatchOverviewInclude = {
  uploadedFiles: {
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      originalFilename: true,
      detectedReportType: true,
      parseStatus: true,
      storagePointer: true,
      rawContentByteLength: true,
      rowCount: true,
      warningCount: true,
      errorMessage: true,
    },
  },
  auditSnapshot: {
    select: {
      id: true,
      syncStatus: true,
      productCount: true,
      variantCount: true,
      inventoryItemCount: true,
      inventoryLevelCount: true,
      locationCount: true,
      errorMessage: true,
      syncedAt: true,
    },
  },
} satisfies Prisma.UploadBatchInclude;

export async function getOwnedUploadBatch({
  storeId,
  batchId,
}: {
  storeId: string;
  batchId: string | null;
}) {
  if (!batchId) {
    return null;
  }

  return db.uploadBatch.findFirst({
    where: { id: batchId, storeId },
    include: uploadBatchOverviewInclude,
  });
}

export async function requireOwnedUploadBatch({
  storeId,
  batchId,
}: {
  storeId: string;
  batchId: string | null;
}) {
  const batch = await getOwnedUploadBatch({ storeId, batchId });

  if (!batch) {
    throw new Response("The selected migration run was not found.", {
      status: 404,
    });
  }

  return batch;
}
