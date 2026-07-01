import { BillingStatus } from "@prisma/client";
import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

type AppPurchaseOneTimePayload = {
  app_purchase_one_time?: {
    name?: string;
    status?: string;
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, topic } = await authenticate.webhook(request);
  const purchase = (payload as AppPurchaseOneTimePayload).app_purchase_one_time;

  console.log(`Received ${topic} webhook for ${shop}`);

  if (!purchase?.status) {
    return new Response();
  }

  await db.store.updateMany({
    where: { shop },
    data: {
      billingStatus:
        purchase.status === "ACTIVE"
          ? BillingStatus.ACTIVE
          : BillingStatus.NOT_STARTED,
    },
  });

  return new Response();
};
