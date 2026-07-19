ALTER TABLE "Store"
ADD COLUMN "billingPlan" TEXT,
ADD COLUMN "billingCheckedAt" TIMESTAMP(3),
ADD COLUMN "billingEndedAt" TIMESTAMP(3);

UPDATE "Store"
SET "billingCheckedAt" = CURRENT_TIMESTAMP
WHERE "billingStatus" = 'ACTIVE';

ALTER TABLE "UploadBatch"
ADD COLUMN "auditSnapshotId" TEXT,
ADD COLUMN "auditedAt" TIMESTAMP(3);

CREATE INDEX "UploadBatch_auditSnapshotId_idx" ON "UploadBatch"("auditSnapshotId");

ALTER TABLE "UploadBatch"
ADD CONSTRAINT "UploadBatch_auditSnapshotId_fkey"
FOREIGN KEY ("auditSnapshotId") REFERENCES "ShopifyCatalogSnapshot"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
