import type {
  AdminGraphqlClient,
  PartnerBillingCheck,
} from "../models/billing.server";
import { getPartnerBillingEvidence } from "../models/billing.server";

const REQUIRED_SCOPES = ["read_products", "read_inventory", "read_locations"];

export type HostedSmokeResult = {
  shop: { id: string; myshopifyDomain: string };
  accessScopes: string[];
  productSamples: number;
  locationSamples: number;
};

export type HostedSmokeDependencies = {
  getAdmin: (shop: string) => Promise<{ admin: AdminGraphqlClient }>;
  getSmokeResult: (admin: AdminGraphqlClient) => Promise<HostedSmokeResult>;
  getBillingCheck: (args: {
    shop: string;
    shopId: string | null;
  }) => Promise<PartnerBillingCheck>;
};

export async function runHostedSmokeProof({
  shop,
  dependencies,
}: {
  shop: string;
  dependencies: HostedSmokeDependencies;
}) {
  let smokeResult: HostedSmokeResult;

  try {
    const { admin } = await dependencies.getAdmin(shop);
    smokeResult = await dependencies.getSmokeResult(admin);
  } catch (error) {
    return {
      status: 424,
      body: {
        ok: false,
        shop,
        tokenSource: "Shopify SDK offline session",
        error: safeOfflineSessionError(error, shop),
      },
    };
  }

  const grantedScopes = smokeResult.accessScopes.sort();
  const missingScopes = REQUIRED_SCOPES.filter(
    (scope) => !grantedScopes.includes(scope),
  );
  const billingCheck = await dependencies.getBillingCheck({
    shop,
    shopId: smokeResult.shop.id,
  });
  const failures = [
    ...missingScopes.map((scope) => `Missing scope: ${scope}`),
    ...billingCheck.errors,
    smokeResult.productSamples < 0
      ? "Products query returned no connection."
      : null,
    smokeResult.locationSamples < 0
      ? "Locations query returned no connection."
      : null,
  ].filter((failure): failure is string => Boolean(failure));

  return {
    status: failures.length === 0 ? 200 : 424,
    body: {
      ok: failures.length === 0,
      shop,
      tokenSource: "Shopify SDK offline session",
      shopId: smokeResult.shop.id,
      billingActive: billingCheck.active,
      billingEvidence: getPartnerBillingEvidence(billingCheck),
      grantedScopes,
      productSamples: smokeResult.productSamples,
      locationSamples: smokeResult.locationSamples,
      failures,
    },
  };
}

function safeOfflineSessionError(error: unknown, shop: string) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  const name = error instanceof Error ? error.name : "";

  if (name === "SessionNotFoundError" || message.includes("find a session")) {
    return `No offline Shopify session found for ${shop}.`;
  }

  return `The Shopify SDK could not refresh or use the offline session for ${shop}.`;
}
