import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, session, topic, shop } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  const current = Array.isArray(payload.current)
    ? payload.current.join(",")
    : null;

  if (session && current) {
    await db.session.update({
      where: {
        id: session.id,
      },
      data: {
        scope: current,
      },
    });
  }

  if (current) {
    await db.store.updateMany({
      where: { shop },
      data: { scopes: current },
    });
  }

  return new Response();
};
