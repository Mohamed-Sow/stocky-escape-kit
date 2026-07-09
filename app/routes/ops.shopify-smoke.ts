import type { LoaderFunctionArgs } from "react-router";

import db from "../db.server";
import { BILLING_PLAN_NAMES } from "../models/billing.server";

const API_VERSION = "2026-07";
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

  let payload: SmokePayload;

  try {
    payload = await adminGraphql({
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
  const installation = payload.data?.currentAppInstallation;
  const grantedScopes =
    installation?.accessScopes.map((scope) => scope.handle).sort() ?? [];
  const missingScopes = REQUIRED_SCOPES.filter(
    (scope) => !grantedScopes.includes(scope),
  );
  const activeSubscription = installation?.activeSubscriptions.find(
    (subscription) =>
      subscription.status === "ACTIVE" &&
      (BILLING_PLAN_NAMES as readonly string[]).includes(subscription.name),
  );
  const billingName = activeSubscription?.name ?? null;
  const failures = [
    ...missingScopes.map((scope) => `Missing scope: ${scope}`),
    !billingName
      ? "No active Stocky Escape Kit App Pricing subscription was found."
      : null,
    !payload.data?.products ? "Products query returned no connection." : null,
    !payload.data?.locations ? "Locations query returned no connection." : null,
  ].filter(Boolean);

  return Response.json(
    {
      ok: failures.length === 0,
      shop,
      tokenSource: "Prisma offline session",
      billingName,
      grantedScopes,
      productSamples: payload.data?.products?.edges.length ?? 0,
      locationSamples: payload.data?.locations?.edges.length ?? 0,
      failures,
    },
    { status: failures.length === 0 ? 200 : 424 },
  );
};

async function adminGraphql({
  shop,
  accessToken,
}: {
  shop: string;
  accessToken: string;
}) {
  const response = await fetch(
    `https://${shop}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query: `#graphql
          query StockyEscapeKitOpsSmoke {
            currentAppInstallation {
              accessScopes {
                handle
              }
              activeSubscriptions {
                name
                status
              }
            }
            products(first: 1) {
              edges {
                node {
                  id
                }
              }
            }
            locations(first: 1) {
              edges {
                node {
                  id
                }
              }
            }
          }
        `,
      }),
    },
  );
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(
      `Shopify GraphQL returned HTTP ${response.status}: ${JSON.stringify(
        payload,
      )}`,
    );
  }

  if (payload.errors?.length) {
    throw new Error(
      `Shopify GraphQL errors: ${payload.errors
        .map((error: { message: string }) => error.message)
        .join("; ")}`,
    );
  }

  return payload as SmokePayload;
}

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

type SmokePayload = {
  data?: {
    currentAppInstallation?: {
      accessScopes: Array<{ handle: string }>;
      activeSubscriptions: Array<{ name: string; status: string }>;
    };
    products?: { edges: Array<{ node: { id: string } }> };
    locations?: { edges: Array<{ node: { id: string } }> };
  };
};
