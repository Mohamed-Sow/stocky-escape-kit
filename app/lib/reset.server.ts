import db from "../db.server";

export const RESET_CONFIRMATION = "DELETE MIGRATION DATA";

export class ResetConfirmationError extends Error {
  constructor() {
    super(`Type ${RESET_CONFIRMATION} to confirm the reset.`);
    this.name = "ResetConfirmationError";
  }
}

export async function resetStoreMigrationData({
  storeId,
  confirmation,
  database = db,
}: {
  storeId: string;
  confirmation: string;
  database?: Pick<typeof db, "$transaction">;
}) {
  if (confirmation !== RESET_CONFIRMATION) {
    throw new ResetConfirmationError();
  }

  return database.$transaction(async (transaction) => {
    const [exportJobs, auditFindings, catalogSnapshots, uploadBatches] =
      await Promise.all([
        transaction.exportJob.deleteMany({ where: { storeId } }),
        transaction.auditFinding.deleteMany({ where: { storeId } }),
        transaction.shopifyCatalogSnapshot.deleteMany({ where: { storeId } }),
        transaction.uploadBatch.deleteMany({ where: { storeId } }),
      ]);

    return {
      exportJobs: exportJobs.count,
      auditFindings: auditFindings.count,
      catalogSnapshots: catalogSnapshots.count,
      uploadBatches: uploadBatches.count,
    };
  });
}
