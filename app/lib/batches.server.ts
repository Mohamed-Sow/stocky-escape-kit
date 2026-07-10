import db from "../db.server";

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
    include: {
      uploadedFiles: { orderBy: { createdAt: "asc" } },
    },
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
