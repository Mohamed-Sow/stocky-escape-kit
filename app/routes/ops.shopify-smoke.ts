import type { LoaderFunctionArgs } from "react-router";
import { runHostedSmokeProof } from "../lib/shopify-smoke.server";
import {
  getAdminGraphqlSmokeResultForAdmin,
  getPartnerBillingCheck,
} from "../models/billing.server";
import { unauthenticated } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const smokeToken = process.env.SHOPIFY_SMOKE_TOKEN?.trim();
  const authorization = request.headers.get("authorization") ?? "";

  if (!smokeToken || authorization !== `Bearer ${smokeToken}`) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const shop = normalizeShop(new URL(request.url).searchParams.get("shop"));

  if (!shop) {
    return Response.json(
      { ok: false, error: "A valid shop query parameter is required." },
      { status: 400 },
    );
  }

  const proof = await runHostedSmokeProof({
    shop,
    dependencies: {
      getAdmin: unauthenticated.admin,
      getSmokeResult: getAdminGraphqlSmokeResultForAdmin,
      getBillingCheck: getPartnerBillingCheck,
    },
  });

  return Response.json(proof.body, { status: proof.status });
};

function normalizeShop(value: string | null) {
  if (!value) return null;
  const shop = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) ? shop : null;
}
