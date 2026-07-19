import { BillingStatus } from "@prisma/client";
import db from "../db.server";

const PARTNER_API_VERSION = "2026-07";
const PARTNER_ENV_KEYS = [
  "SHOPIFY_PARTNER_ORG_ID",
  "SHOPIFY_PARTNER_API_TOKEN",
  "SHOPIFY_PARTNER_APP_ID",
] as const;

export const PUBLIC_BILLING_PLANS = {
  basic: "Stocky Escape Kit Basic",
  pro: "Stocky Escape Kit Pro",
  plus: "Stocky Escape Kit Plus",
} as const;

export const PUBLIC_BILLING_PLAN_INVOICE_NAMES = {
  basic: "Stocky Basic",
  pro: "Stocky Pro",
  plus: "Stocky Plus",
} as const;

export const PRIVATE_TEST_BILLING_PLAN = "shopify-test";
export const PRIVATE_TEST_BILLING_DISPLAY_NAME = "Stocky Review Test";
export const DEFAULT_SHOPIFY_APP_HANDLE = "stocky-escape-kit-1";

export type PublicBillingPlanName =
  (typeof PUBLIC_BILLING_PLANS)[keyof typeof PUBLIC_BILLING_PLANS];
export type PublicBillingPlanInvoiceName =
  (typeof PUBLIC_BILLING_PLAN_INVOICE_NAMES)[keyof typeof PUBLIC_BILLING_PLAN_INVOICE_NAMES];
export type BillingPlanName =
  | PublicBillingPlanName
  | PublicBillingPlanInvoiceName
  | typeof PRIVATE_TEST_BILLING_PLAN
  | typeof PRIVATE_TEST_BILLING_DISPLAY_NAME;

export type PartnerBillingItemPrice = {
  type: string;
  active: boolean | null;
  currency: string | null;
  amount: string | null;
  tiersMode: string | null;
  tiers: Array<{
    upTo: number | null;
    amountPerUnit: string | null;
    amount: string | null;
  }>;
};

export type PartnerBillingItem = {
  handle: string | null;
  description: string | null;
  price: PartnerBillingItemPrice | null;
};

export type PartnerBillingSubscription = {
  billingPeriod: string | null;
  cancelAtEndOfCycle: boolean | null;
  trialEndsAt: string | null;
  currentBillingCycle: {
    startTime: string | null;
    endTime: string | null;
  } | null;
  items: PartnerBillingItem[];
  legacySubscriptionId: string | null;
};

export type PartnerBillingCheck = {
  active: boolean;
  verified?: boolean;
  shop: string;
  shopId: string | null;
  source: "Partner API activeSubscription";
  subscription: PartnerBillingSubscription | null;
  missingEnv: string[];
  errors: string[];
};

export type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

type AdminGraphqlShopIdentity = {
  id: string;
  myshopifyDomain: string;
};

type AdminGraphqlSmokeResult = {
  shop: AdminGraphqlShopIdentity;
  accessScopes: string[];
  productSamples: number;
  locationSamples: number;
};

type PartnerActiveSubscriptionPayload = {
  data?: {
    activeSubscription?: {
      billingPeriod?: string | null;
      cancelAtEndOfCycle?: boolean | null;
      trialEndsAt?: string | null;
      currentBillingCycle?: {
        startTime?: string | null;
        endTime?: string | null;
      } | null;
      items?: Array<{
        handle?: string | null;
        description?: string | null;
        price?: {
          __typename?: string;
          active?: boolean | null;
          currency?: string | null;
          amount?: string | null;
          tiersMode?: string | null;
          tiers?: Array<{
            upTo?: number | null;
            amountPerUnit?: string | null;
            amount?: string | null;
          }>;
        } | null;
      }>;
      legacySubscriptionId?: string | null;
    } | null;
  };
  errors?: Array<{ message: string }>;
};

type PartnerActiveSubscription = NonNullable<
  NonNullable<PartnerActiveSubscriptionPayload["data"]>["activeSubscription"]
>;

export const BILLING_PLAN_DETAILS = [
  {
    id: "basic",
    name: PUBLIC_BILLING_PLANS.basic,
    invoiceName: PUBLIC_BILLING_PLAN_INVOICE_NAMES.basic,
    price: "$99/mo",
    summary:
      "All migration reports and the review kit; up to 10 files, 10 MB, and 40,000 parsed rows per run.",
  },
  {
    id: "pro",
    name: PUBLIC_BILLING_PLANS.pro,
    invoiceName: PUBLIC_BILLING_PLAN_INVOICE_NAMES.pro,
    price: "$199/mo",
    summary:
      "The same complete workflow with up to 20 files, 15 MB, and 60,000 parsed rows per run.",
  },
  {
    id: "plus",
    name: PUBLIC_BILLING_PLANS.plus,
    invoiceName: PUBLIC_BILLING_PLAN_INVOICE_NAMES.plus,
    price: "$299/mo",
    summary:
      "The same complete workflow with up to 30 files, 20 MB, and 75,000 parsed rows per run.",
  },
] as const;

export const PUBLIC_BILLING_PLAN_NAMES = Object.values(
  PUBLIC_BILLING_PLANS,
) as PublicBillingPlanName[];

export const PUBLIC_BILLING_PLAN_INVOICE_NAME_VALUES = Object.values(
  PUBLIC_BILLING_PLAN_INVOICE_NAMES,
) as PublicBillingPlanInvoiceName[];

export const BILLING_PLAN_NAMES: BillingPlanName[] = [
  ...PUBLIC_BILLING_PLAN_NAMES,
  ...PUBLIC_BILLING_PLAN_INVOICE_NAME_VALUES,
  PRIVATE_TEST_BILLING_PLAN,
  PRIVATE_TEST_BILLING_DISPLAY_NAME,
];

export function isValidBillingPlan(plan: unknown): plan is BillingPlanName {
  return (
    typeof plan === "string" &&
    (BILLING_PLAN_NAMES as readonly string[]).includes(plan)
  );
}

export function isBillingTestMode() {
  if (process.env.SHOPIFY_BILLING_TEST === "true") {
    return true;
  }

  if (process.env.SHOPIFY_BILLING_TEST === "false") {
    return false;
  }

  return process.env.NODE_ENV !== "production";
}

export function getActiveBillingName(check: PartnerBillingCheck) {
  const item = getPrimaryBillingItem(check);

  if (item?.handle === PRIVATE_TEST_BILLING_PLAN) {
    return PRIVATE_TEST_BILLING_DISPLAY_NAME;
  }

  return item?.description ?? item?.handle ?? null;
}

export function hasActiveBillingSubscription(check: PartnerBillingCheck) {
  return check.active;
}

export function getPartnerBillingEvidence(check: PartnerBillingCheck) {
  return (
    check.subscription?.items.map((item) => ({
      handle: item.handle,
      description: item.description,
      price: formatBillingItemPrice(item.price),
    })) ?? []
  );
}

export function getPlanSelectionUrl(shop: string) {
  const storeHandle = shop.replace(/\.myshopify\.com$/i, "");
  const appHandle =
    process.env.SHOPIFY_APP_HANDLE?.trim() || DEFAULT_SHOPIFY_APP_HANDLE;

  return `https://admin.shopify.com/store/${encodeURIComponent(
    storeHandle,
  )}/charges/${encodeURIComponent(appHandle)}/pricing_plans`;
}

export async function getAdminGraphqlSmokeResult({
  shop,
  accessToken,
}: {
  shop: string;
  accessToken: string;
}) {
  const payload = await directAdminGraphql({
    shop,
    accessToken,
    query: `#graphql
      query StockyEscapeKitAdminSmoke {
        shop {
          id
          myshopifyDomain
        }
        currentAppInstallation {
          accessScopes {
            handle
          }
        }
        products(first: 1) {
          edges {
            node {
              id
              title
            }
          }
        }
        locations(first: 1) {
          edges {
            node {
              id
              name
            }
          }
        }
      }
    `,
  });

  return normalizeAdminGraphqlSmokePayload(payload);
}

export async function getAdminGraphqlSmokeResultForAdmin(
  admin: AdminGraphqlClient,
) {
  const response = await admin.graphql(`#graphql
    query StockyEscapeKitAdminSmoke {
      shop {
        id
        myshopifyDomain
      }
      currentAppInstallation {
        accessScopes {
          handle
        }
      }
      products(first: 1) {
        edges { node { id title } }
      }
      locations(first: 1) {
        edges { node { id name } }
      }
    }
  `);
  const payload = await response.json();
  assertGraphqlResponse(response, payload, "Shopify Admin GraphQL smoke query");

  return normalizeAdminGraphqlSmokePayload(payload);
}

export async function getAdminShopIdentity(admin: AdminGraphqlClient) {
  const response = await admin.graphql(`#graphql
    query StockyEscapeKitShopIdentity {
      shop {
        id
        myshopifyDomain
      }
    }
  `);
  const payload = await response.json();
  assertGraphqlResponse(response, payload, "Shopify Admin GraphQL shop query");

  const shop = payload.data?.shop;

  if (!shop?.id || !shop?.myshopifyDomain) {
    throw new Error("Shopify Admin GraphQL shop query returned no shop ID.");
  }

  return shop as AdminGraphqlShopIdentity;
}

export async function getPartnerBillingCheckForAdmin({
  admin,
  shop,
}: {
  admin: AdminGraphqlClient;
  shop: string;
}) {
  let shopId: string;

  try {
    const identity = await getAdminShopIdentity(admin);
    shopId = identity.id;
  } catch (error) {
    return inactivePartnerBillingCheck({
      shop,
      shopId: null,
      errors: [
        error instanceof Error
          ? error.message
          : "Unknown Shopify Admin shop identity failure.",
      ],
    });
  }

  return getPartnerBillingCheck({
    shop,
    shopId,
  });
}

export async function getPartnerBillingCheck({
  shop,
  shopId,
}: {
  shop: string;
  shopId: string | null;
}): Promise<PartnerBillingCheck> {
  const config = getPartnerApiConfig();

  if (!shopId) {
    return inactivePartnerBillingCheck({
      shop,
      shopId,
      errors: ["Shopify Admin GraphQL did not return a shop ID."],
    });
  }

  if (config.missingEnv.length > 0) {
    return inactivePartnerBillingCheck({
      shop,
      shopId,
      missingEnv: config.missingEnv,
      errors: [
        `Partner API billing check is not configured. Missing: ${config.missingEnv.join(
          ", ",
        )}.`,
      ],
    });
  }

  let payload: PartnerActiveSubscriptionPayload;

  try {
    payload = await partnerGraphql({
      organizationId: config.organizationId,
      accessToken: config.accessToken,
      query: `#graphql
        query StockyEscapeKitActiveSubscription($appId: ID!, $shopId: ID!) {
          activeSubscription(appId: $appId, shopId: $shopId) {
            billingPeriod
            cancelAtEndOfCycle
            trialEndsAt
            currentBillingCycle {
              startTime
              endTime
            }
            items {
              handle
              description
              price {
                __typename
                active
                currency
                ... on FlatRatePrice {
                  amount
                }
                ... on TieredPrice {
                  tiersMode
                  tiers {
                    upTo
                    amountPerUnit
                    amount
                  }
                }
              }
            }
            legacySubscriptionId
          }
        }
      `,
      variables: {
        appId: config.appId,
        shopId,
      },
    });
  } catch (error) {
    return inactivePartnerBillingCheck({
      shop,
      shopId,
      errors: [
        error instanceof Error
          ? error.message
          : "Unknown Partner API activeSubscription failure.",
      ],
    });
  }

  if (payload.errors?.length) {
    return inactivePartnerBillingCheck({
      shop,
      shopId,
      errors: payload.errors.map((error) => error.message),
    });
  }

  const subscription = normalizePartnerSubscription(
    payload.data?.activeSubscription ?? null,
  );

  return {
    active: subscription !== null,
    verified: true,
    shop,
    shopId,
    source: "Partner API activeSubscription",
    subscription,
    missingEnv: [],
    errors: subscription
      ? []
      : ["Partner API returned no active Shopify App Pricing subscription."],
  };
}

export async function updateStoreBillingStatus({
  shop,
  billingCheck,
}: {
  shop: string;
  billingCheck: PartnerBillingCheck;
}) {
  const current = await db.store.findUnique({
    where: { shop },
    select: {
      billingStatus: true,
      billingEndedAt: true,
    },
  });

  if (billingCheck.verified === false) {
    return current?.billingStatus ?? BillingStatus.NOT_STARTED;
  }

  const active = hasActiveBillingSubscription(billingCheck);
  const billingStatus = active
    ? BillingStatus.ACTIVE
    : current?.billingStatus === BillingStatus.ACTIVE ||
        current?.billingStatus === BillingStatus.CANCELED
      ? BillingStatus.CANCELED
      : BillingStatus.NOT_STARTED;
  const checkedAt = new Date();

  await db.store.updateMany({
    where: { shop },
    data: active
      ? {
          billingStatus,
          billingPlan: getActiveBillingName(billingCheck),
          billingCheckedAt: checkedAt,
          billingEndedAt: null,
        }
      : {
          billingStatus,
          billingCheckedAt: checkedAt,
          billingEndedAt:
            billingStatus === BillingStatus.CANCELED
              ? (current?.billingEndedAt ?? checkedAt)
              : null,
        },
  });

  return billingStatus;
}

function getPartnerApiConfig() {
  const organizationId = process.env.SHOPIFY_PARTNER_ORG_ID?.trim() ?? "";
  const accessToken = process.env.SHOPIFY_PARTNER_API_TOKEN?.trim() ?? "";
  const appId = process.env.SHOPIFY_PARTNER_APP_ID?.trim() ?? "";
  const missingEnv = PARTNER_ENV_KEYS.filter(
    (key) => !process.env[key]?.trim(),
  );

  return {
    organizationId,
    accessToken,
    appId,
    missingEnv: [...missingEnv],
  };
}

function inactivePartnerBillingCheck({
  shop,
  shopId,
  missingEnv = [],
  errors = [],
}: {
  shop: string;
  shopId: string | null;
  missingEnv?: string[];
  errors?: string[];
}): PartnerBillingCheck {
  return {
    active: false,
    verified: false,
    shop,
    shopId,
    source: "Partner API activeSubscription",
    subscription: null,
    missingEnv,
    errors,
  };
}

async function directAdminGraphql({
  shop,
  accessToken,
  query,
}: {
  shop: string;
  accessToken: string;
  query: string;
}) {
  const response = await fetch(
    `https://${shop}/admin/api/${PARTNER_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query }),
    },
  );
  const payload = await response.json();
  assertGraphqlResponse(response, payload, "Shopify Admin GraphQL");

  return payload;
}

async function partnerGraphql({
  organizationId,
  accessToken,
  query,
  variables,
}: {
  organizationId: string;
  accessToken: string;
  query: string;
  variables: Record<string, unknown>;
}) {
  const response = await fetch(
    `https://partners.shopify.com/${organizationId}/api/${PARTNER_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({ query, variables }),
    },
  );
  const payload = await response.json();
  assertGraphqlResponse(response, payload, "Shopify Partner API");

  return payload as PartnerActiveSubscriptionPayload;
}

function assertGraphqlResponse(
  response: Response,
  payload: { errors?: Array<{ message: string }> },
  label: string,
) {
  if (!response.ok) {
    throw new Error(
      `${label} returned HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
  }

  if (payload.errors?.length) {
    throw new Error(
      `${label} errors: ${payload.errors
        .map((error) => error.message)
        .join("; ")}`,
    );
  }
}

function normalizeAdminGraphqlSmokePayload(
  payload: Record<string, unknown>,
): AdminGraphqlSmokeResult {
  const data = payload.data as
    | {
        shop?: AdminGraphqlShopIdentity;
        currentAppInstallation?: {
          accessScopes?: Array<{ handle: string }>;
        };
        products?: { edges?: unknown[] };
        locations?: { edges?: unknown[] };
      }
    | undefined;

  if (!data?.shop?.id || !data.shop.myshopifyDomain) {
    throw new Error("Shopify Admin GraphQL returned no shop ID.");
  }

  return {
    shop: data.shop,
    accessScopes:
      data.currentAppInstallation?.accessScopes?.map((scope) => scope.handle) ??
      [],
    productSamples: data.products?.edges?.length ?? -1,
    locationSamples: data.locations?.edges?.length ?? -1,
  };
}

function normalizePartnerSubscription(
  subscription: PartnerActiveSubscription | null,
): PartnerBillingSubscription | null {
  if (!subscription) {
    return null;
  }

  return {
    billingPeriod: subscription.billingPeriod ?? null,
    cancelAtEndOfCycle: subscription.cancelAtEndOfCycle ?? null,
    trialEndsAt: subscription.trialEndsAt ?? null,
    currentBillingCycle: subscription.currentBillingCycle
      ? {
          startTime: subscription.currentBillingCycle.startTime ?? null,
          endTime: subscription.currentBillingCycle.endTime ?? null,
        }
      : null,
    items:
      subscription.items?.map((item) => ({
        handle: item.handle ?? null,
        description: item.description ?? null,
        price: item.price
          ? {
              type: item.price.__typename ?? "UnknownPrice",
              active: item.price.active ?? null,
              currency: item.price.currency ?? null,
              amount: item.price.amount ?? null,
              tiersMode: item.price.tiersMode ?? null,
              tiers:
                item.price.tiers?.map((tier) => ({
                  upTo: tier.upTo ?? null,
                  amountPerUnit: tier.amountPerUnit ?? null,
                  amount: tier.amount ?? null,
                })) ?? [],
            }
          : null,
      })) ?? [],
    legacySubscriptionId: subscription.legacySubscriptionId ?? null,
  };
}

function getPrimaryBillingItem(check: PartnerBillingCheck) {
  return check.subscription?.items.find((item) => item.handle) ?? null;
}

function formatBillingItemPrice(price: PartnerBillingItemPrice | null) {
  if (!price) {
    return null;
  }

  if (price.amount && price.currency) {
    return `${price.amount} ${price.currency}`;
  }

  if (price.amount) {
    return price.amount;
  }

  if (price.tiers.length > 0) {
    return price.tiers
      .map((tier) => tier.amount ?? tier.amountPerUnit)
      .filter(Boolean)
      .join(", ");
  }

  return price.type;
}
