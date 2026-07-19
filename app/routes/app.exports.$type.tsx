import { ExportType } from "@prisma/client";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  getPartnerBillingCheckForAdmin,
  updateStoreBillingStatus,
} from "../models/billing.server";
import { upsertInstalledStore } from "../models/store.server";
import { generateExport, isExportType } from "../lib/exports.server";
import { requireOwnedUploadBatch } from "../lib/batches.server";
import {
  canGenerateExport,
  resolveBillingAccess,
} from "../lib/entitlements.server";

async function exportResponse({
  request,
  params,
}: LoaderFunctionArgs | ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const store = await upsertInstalledStore({
    shop: session.shop,
    scopes: session.scope ?? null,
  });
  const billingCheck = await getPartnerBillingCheckForAdmin({
    admin,
    shop: session.shop,
  });
  const billingStatus = await updateStoreBillingStatus({
    shop: session.shop,
    billingCheck,
  });
  const billingAccess = resolveBillingAccess({
    billingCheck,
    billingStatus,
    storedPlan: store.billingPlan,
    storedCheckedAt: store.billingCheckedAt,
  });

  if (!billingAccess.active) {
    throw new Response(
      "An active Stocky Escape Kit subscription is required before generating reports.",
      { status: 402 },
    );
  }

  const exportType = params.type;
  const batchId = new URL(request.url).searchParams.get("batch");

  if (!isExportType(exportType)) {
    throw new Response("Unknown export type.", { status: 404 });
  }

  if (!canGenerateExport(billingAccess.entitlements, exportType)) {
    throw new Response(
      `${billingAccess.entitlements.label} does not include this report. Change plans through Shopify App Pricing.`,
      { status: 403 },
    );
  }

  const batch = await requireOwnedUploadBatch({ storeId: store.id, batchId });
  const exportFile = await generateExport({
    storeId: store.id,
    batchId: batch.id,
    exportType,
    options: {
      priorityChecklist: billingAccess.entitlements.priorityChecklist,
      includeLocationMismatches: billingAccess.entitlements.locationAudit,
    },
  });

  return new Response(exportFile.body, {
    headers: {
      "Content-Type": exportFile.contentType,
      "Content-Disposition": `attachment; filename="${exportFile.filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

export const loader = exportResponse;
export const action = exportResponse;

export const EXPORT_LABELS: Record<ExportType, string> = {
  ARCHIVE_CSV: "Archive CSV",
  SKU_GAP_REPORT: "SKU gap report",
  SUPPLIER_RECONSTRUCTION_REPORT: "Supplier reconstruction",
  MIGRATION_CHECKLIST: "Migration checklist",
};
