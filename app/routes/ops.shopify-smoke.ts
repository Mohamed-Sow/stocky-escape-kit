import { timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
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

  if (!smokeToken || !matchesBearerToken(authorization, smokeToken)) {
    return smokeJson({ ok: false, error: "Unauthorized" }, 401);
  }

  const shop = normalizeShop(new URL(request.url).searchParams.get("shop"));

  if (!shop) {
    return smokeJson(
      { ok: false, error: "A valid shop query parameter is required." },
      400,
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

  return smokeJson(proof.body, proof.status);
};

function matchesBearerToken(authorization: string, token: string) {
  const received = Buffer.from(authorization);
  const expected = Buffer.from(`Bearer ${token}`);

  return (
    received.byteLength === expected.byteLength &&
    timingSafeEqual(received, expected)
  );
}

function smokeJson(body: unknown, status: number) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function normalizeShop(value: string | null) {
  if (!value) return null;
  const shop = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) ? shop : null;
}
