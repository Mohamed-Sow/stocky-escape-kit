import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhooks are idempotent. Store deletion cascades to every upload, raw CSV,
  // parsed row, catalog snapshot, finding, and export record for this shop.
  await db.session.deleteMany({ where: { shop } });
  await db.store.deleteMany({ where: { shop } });

  return new Response();
};
