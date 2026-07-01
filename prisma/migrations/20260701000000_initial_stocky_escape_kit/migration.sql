-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "BillingStatus" AS ENUM ('NOT_STARTED', 'ACTIVE', 'PAST_DUE', 'CANCELED');

-- CreateEnum
CREATE TYPE "UploadBatchStatus" AS ENUM ('PENDING', 'IMPORTING', 'IMPORTED', 'FAILED');

-- CreateEnum
CREATE TYPE "FileParseStatus" AS ENUM ('PENDING', 'PARSED', 'FAILED');

-- CreateEnum
CREATE TYPE "StockyReportType" AS ENUM ('PURCHASE_ORDERS', 'STOCKTAKES', 'HISTORICAL_COSTS', 'INVENTORY_ACTIVITY', 'PRODUCTS', 'VENDORS', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "FindingSeverity" AS ENUM ('CRITICAL', 'WARNING', 'INFO');

-- CreateEnum
CREATE TYPE "FindingCategory" AS ENUM ('MISSING_SKU', 'DUPLICATE_SKU', 'MISSING_COST', 'MISSING_BARCODE', 'MISSING_VENDOR', 'LOCATION_MISMATCH', 'OPEN_PURCHASE_ORDER_INDICATOR', 'SUPPLIER_RECONSTRUCTION_CANDIDATE', 'PARSE_ERROR');

-- CreateEnum
CREATE TYPE "ExportType" AS ENUM ('ARCHIVE_CSV', 'SKU_GAP_REPORT', 'SUPPLIER_RECONSTRUCTION_REPORT', 'MIGRATION_CHECKLIST');

-- CreateEnum
CREATE TYPE "ExportStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Store" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "installed" BOOLEAN NOT NULL DEFAULT true,
    "scopes" TEXT,
    "billingStatus" "BillingStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "uninstalledAt" TIMESTAMP(3),

    CONSTRAINT "Store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UploadBatch" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "status" "UploadBatchStatus" NOT NULL DEFAULT 'PENDING',
    "fileCount" INTEGER NOT NULL DEFAULT 0,
    "importedRowCount" INTEGER NOT NULL DEFAULT 0,
    "warningCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UploadBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UploadedFile" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "detectedReportType" "StockyReportType" NOT NULL DEFAULT 'UNKNOWN',
    "parseStatus" "FileParseStatus" NOT NULL DEFAULT 'PENDING',
    "storagePointer" TEXT NOT NULL,
    "contentSha256" TEXT,
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "warningCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UploadedFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParsedRecord" (
    "id" TEXT NOT NULL,
    "uploadedFileId" TEXT NOT NULL,
    "normalizedType" "StockyReportType" NOT NULL,
    "sourceRowNumber" INTEGER NOT NULL,
    "sku" TEXT,
    "normalizedPayload" JSONB NOT NULL,
    "warnings" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ParsedRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyCatalogSnapshot" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "syncStatus" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "productCount" INTEGER NOT NULL DEFAULT 0,
    "variantCount" INTEGER NOT NULL DEFAULT 0,
    "inventoryItemCount" INTEGER NOT NULL DEFAULT 0,
    "inventoryLevelCount" INTEGER NOT NULL DEFAULT 0,
    "locationCount" INTEGER NOT NULL DEFAULT 0,
    "summary" JSONB,
    "errorMessage" TEXT,
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyCatalogSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditFinding" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "batchId" TEXT,
    "severity" "FindingSeverity" NOT NULL,
    "category" "FindingCategory" NOT NULL,
    "sku" TEXT,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "recommendedAction" TEXT NOT NULL,
    "source" JSONB,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExportJob" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "exportType" "ExportType" NOT NULL,
    "status" "ExportStatus" NOT NULL DEFAULT 'PENDING',
    "generatedFilePointer" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ExportJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Store_shop_key" ON "Store"("shop");

-- CreateIndex
CREATE INDEX "Store_installed_idx" ON "Store"("installed");

-- CreateIndex
CREATE INDEX "UploadBatch_storeId_status_idx" ON "UploadBatch"("storeId", "status");

-- CreateIndex
CREATE INDEX "UploadedFile_batchId_detectedReportType_idx" ON "UploadedFile"("batchId", "detectedReportType");

-- CreateIndex
CREATE INDEX "ParsedRecord_uploadedFileId_sourceRowNumber_idx" ON "ParsedRecord"("uploadedFileId", "sourceRowNumber");

-- CreateIndex
CREATE INDEX "ParsedRecord_sku_idx" ON "ParsedRecord"("sku");

-- CreateIndex
CREATE INDEX "ShopifyCatalogSnapshot_storeId_syncStatus_idx" ON "ShopifyCatalogSnapshot"("storeId", "syncStatus");

-- CreateIndex
CREATE INDEX "AuditFinding_storeId_severity_idx" ON "AuditFinding"("storeId", "severity");

-- CreateIndex
CREATE INDEX "AuditFinding_batchId_category_idx" ON "AuditFinding"("batchId", "category");

-- CreateIndex
CREATE INDEX "AuditFinding_sku_idx" ON "AuditFinding"("sku");

-- CreateIndex
CREATE INDEX "ExportJob_storeId_exportType_idx" ON "ExportJob"("storeId", "exportType");

-- CreateIndex
CREATE INDEX "ExportJob_status_idx" ON "ExportJob"("status");

-- AddForeignKey
ALTER TABLE "UploadBatch" ADD CONSTRAINT "UploadBatch_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadedFile" ADD CONSTRAINT "UploadedFile_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "UploadBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParsedRecord" ADD CONSTRAINT "ParsedRecord_uploadedFileId_fkey" FOREIGN KEY ("uploadedFileId") REFERENCES "UploadedFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyCatalogSnapshot" ADD CONSTRAINT "ShopifyCatalogSnapshot_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditFinding" ADD CONSTRAINT "AuditFinding_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditFinding" ADD CONSTRAINT "AuditFinding_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "UploadBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExportJob" ADD CONSTRAINT "ExportJob_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
