import { ExportType } from "@prisma/client";
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  hasActiveBillingSubscription,
  isBillingTestMode,
  updateStoreBillingStatus,
} from "../models/billing.server";
import { upsertInstalledStore } from "../models/store.server";
import { generateExport, isExportType } from "../lib/exports.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);
  const store = await upsertInstalledStore({
    shop: session.shop,
    scopes: session.scope ?? null,
  });
  const billingCheck = await billing.check({ isTest: isBillingTestMode() });

  await updateStoreBillingStatus({
    shop: session.shop,
    billingCheck,
  });

  if (!hasActiveBillingSubscription(billingCheck)) {
    throw new Response(
      "A Stocky Escape Kit App Pricing subscription is required before exporting reports.",
      {
        status: 402,
      },
    );
  }

  const exportType = params.type;

  if (!isExportType(exportType)) {
    throw new Response("Unknown export type.", { status: 404 });
  }

  const exportFile = await generateExport({
    storeId: store.id,
    exportType,
  });

  return new Response(exportFile.body, {
    headers: {
      "Content-Type": exportFile.contentType,
      "Content-Disposition": `attachment; filename="${exportFile.filename}"`,
      "Cache-Control": "no-store",
    },
  });
};

export const EXPORT_LABELS: Record<ExportType, string> = {
  ARCHIVE_CSV: "Archive CSV",
  SKU_GAP_REPORT: "SKU gap report",
  SUPPLIER_RECONSTRUCTION_REPORT: "Supplier reconstruction",
  MIGRATION_CHECKLIST: "Migration checklist",
};
