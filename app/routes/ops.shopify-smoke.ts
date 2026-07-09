import type { LoaderFunctionArgs } from "react-router";

import db from "../db.server";
import {
  getAdminGraphqlSmokeResult,
  getPartnerBillingCheck,
  getPartnerBillingEvidence,
} from "../models/billing.server";

const REQUIRED_SCOPES = ["read_products", "read_inventory", "read_locations"];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const smokeToken = process.env.SHOPIFY_SMOKE_TOKEN?.trim();
  const authorization = request.headers.get("authorization") ?? "";

  if (!smokeToken || authorization !== `Bearer ${smokeToken}`) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const shop = normalizeShop(url.searchParams.get("shop"));

  if (!shop) {
    return Response.json(
      { ok: false, error: "A valid shop query parameter is required." },
      { status: 400 },
    );
  }

  const session = await db.session.findFirst({
    where: {
      shop,
      isOnline: false,
    },
    orderBy: {
      id: "desc",
    },
  });

  if (!session?.accessToken) {
    return Response.json(
      { ok: false, error: `No offline Shopify session found for ${shop}.` },
      { status: 424 },
    );
  }

  if (session.expires && session.expires <= new Date()) {
    return Response.json(
      {
        ok: false,
        error: `Offline Shopify session for ${shop} expired at ${session.expires.toISOString()}.`,
      },
      { status: 424 },
    );
  }

  let smokeResult: Awaited<ReturnType<typeof getAdminGraphqlSmokeResult>>;

  try {
    smokeResult = await getAdminGraphqlSmokeResult({
      shop,
      accessToken: session.accessToken,
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        shop,
        tokenSource: "Prisma offline session",
        error:
          error instanceof Error
            ? error.message
            : "Unknown Shopify GraphQL smoke failure.",
      },
      { status: 424 },
    );
  }
  const grantedScopes = smokeResult.accessScopes.sort();
  const missingScopes = REQUIRED_SCOPES.filter(
    (scope) => !grantedScopes.includes(scope),
  );
  const billingCheck = await getPartnerBillingCheck({
    shop,
    shopId: smokeResult.shop.id,
  });
  const billingEvidence = getPartnerBillingEvidence(billingCheck);
  const failures = [
    ...missingScopes.map((scope) => `Missing scope: ${scope}`),
    ...billingCheck.errors,
    smokeResult.productSamples < 0
      ? "Products query returned no connection."
      : null,
    smokeResult.locationSamples < 0
      ? "Locations query returned no connection."
      : null,
  ].filter(Boolean);

  return Response.json(
    {
      ok: failures.length === 0,
      shop,
      tokenSource: "Prisma offline session",
      shopId: smokeResult.shop.id,
      billingActive: billingCheck.active,
      billingEvidence,
      grantedScopes,
      productSamples: smokeResult.productSamples,
      locationSamples: smokeResult.locationSamples,
      failures,
    },
    { status: failures.length === 0 ? 200 : 424 },
  );
};

function normalizeShop(value: string | null) {
  if (!value) {
    return null;
  }

  const shop = value.trim().toLowerCase();

  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
    return null;
  }

  return shop;
}
