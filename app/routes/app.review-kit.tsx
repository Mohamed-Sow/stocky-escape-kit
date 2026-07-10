import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { requireOwnedUploadBatch } from "../lib/batches.server";
import { generateReviewKit } from "../lib/review-kit.server";
import {
  getPartnerBillingCheckForAdmin,
  hasActiveBillingSubscription,
  updateStoreBillingStatus,
} from "../models/billing.server";
import { upsertInstalledStore } from "../models/store.server";

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
  await updateStoreBillingStatus({ shop: session.shop, billingCheck });

  if (!hasActiveBillingSubscription(billingCheck)) {
    throw new Response("An active subscription is required.", { status: 402 });
  }

  const batchId = new URL(request.url).searchParams.get("batch");
  const batch = await requireOwnedUploadBatch({ storeId: store.id, batchId });
  const reviewKit = await generateReviewKit({
    storeId: store.id,
    batchId: batch.id,
  });
  const body = reviewKit.bytes.buffer.slice(
    reviewKit.bytes.byteOffset,
    reviewKit.bytes.byteOffset + reviewKit.bytes.byteLength,
  );

  return new Response(body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${reviewKit.filename}"`,
      "Cache-Control": "no-store",
    },
  });
};
