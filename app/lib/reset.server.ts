import db from "../db.server";

export const RESET_CONFIRMATION = "DELETE MIGRATION DATA";
export const DELETE_RUN_CONFIRMATION = "DELETE THIS RUN";

export class ResetConfirmationError extends Error {
  constructor() {
    super(`Type ${RESET_CONFIRMATION} to confirm the reset.`);
    this.name = "ResetConfirmationError";
  }
}

export class DeleteRunConfirmationError extends Error {
  constructor() {
    super(`Type ${DELETE_RUN_CONFIRMATION} to confirm the run deletion.`);
    this.name = "DeleteRunConfirmationError";
  }
}

export class MigrationRunNotFoundError extends Error {
  constructor() {
    super("The selected migration run was not found.");
    this.name = "MigrationRunNotFoundError";
  }
}

export async function deleteStoreMigrationRun({
  storeId,
  batchId,
  confirmation,
  database = db,
}: {
  storeId: string;
  batchId: string;
  confirmation: string;
  database?: Pick<typeof db, "$transaction">;
}) {
  if (confirmation !== DELETE_RUN_CONFIRMATION) {
    throw new DeleteRunConfirmationError();
  }

  return database.$transaction(async (transaction) => {
    const batch = await transaction.uploadBatch.findFirst({
      where: { id: batchId, storeId },
      select: {
        id: true,
        auditSnapshotId: true,
        fileCount: true,
        importedRowCount: true,
      },
    });

    if (!batch) {
      throw new MigrationRunNotFoundError();
    }

    await transaction.uploadBatch.delete({ where: { id: batch.id } });

    let catalogSnapshotDeleted = false;

    if (batch.auditSnapshotId) {
      const remainingSnapshotLinks = await transaction.uploadBatch.count({
        where: { auditSnapshotId: batch.auditSnapshotId },
      });

      if (remainingSnapshotLinks === 0) {
        const deletedSnapshot =
          await transaction.shopifyCatalogSnapshot.deleteMany({
            where: { id: batch.auditSnapshotId, storeId },
          });
        catalogSnapshotDeleted = deletedSnapshot.count > 0;
      }
    }

    return {
      uploadBatch: 1,
      files: batch.fileCount,
      parsedRows: batch.importedRowCount,
      catalogSnapshots: catalogSnapshotDeleted ? 1 : 0,
    };
  });
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
