import type { LoaderFunctionArgs } from "react-router";
import { resolveBillingAccess } from "../lib/entitlements.server";
import { attachmentContentDisposition } from "../lib/filenames.server";
import { generateOpenPurchaseOrderImportPackage } from "../lib/open-po-import.server";
import { requireOwnedUploadBatch } from "../lib/batches.server";
import {
  getPartnerBillingCheckForAdmin,
  updateStoreBillingStatus,
} from "../models/billing.server";
import { upsertInstalledStore } from "../models/store.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
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

  if (!billingAccess.entitlements.reviewKit) {
    throw new Response(
      "The open purchase-order import package is unavailable for this plan.",
      { status: 403 },
    );
  }

  const batchId = new URL(request.url).searchParams.get("batch");
  const batch = await requireOwnedUploadBatch({ storeId: store.id, batchId });
  const handoff = await generateOpenPurchaseOrderImportPackage({
    storeId: store.id,
    batchId: batch.id,
  });
  const body = handoff.bytes.buffer.slice(
    handoff.bytes.byteOffset,
    handoff.bytes.byteOffset + handoff.bytes.byteLength,
  );

  return new Response(body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": attachmentContentDisposition(handoff.filename),
      "Cache-Control": "no-store",
    },
  });
};
