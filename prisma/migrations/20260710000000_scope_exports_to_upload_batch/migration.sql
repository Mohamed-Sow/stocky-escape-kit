ALTER TABLE "ExportJob" ADD COLUMN "batchId" TEXT;

CREATE INDEX "ExportJob_batchId_createdAt_idx" ON "ExportJob"("batchId", "createdAt");

ALTER TABLE "ExportJob"
ADD CONSTRAINT "ExportJob_batchId_fkey"
FOREIGN KEY ("batchId") REFERENCES "UploadBatch"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
