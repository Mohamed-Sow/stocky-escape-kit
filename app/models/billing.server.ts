import type { BillingCheckResponseObject } from "@shopify/shopify-api";
import { BillingStatus } from "@prisma/client";
import db from "../db.server";

export const PUBLIC_BILLING_PLANS = {
  basic: "Stocky Escape Kit Basic",
  pro: "Stocky Escape Kit Pro",
  plus: "Stocky Escape Kit Plus",
} as const;

export const PRIVATE_TEST_BILLING_PLAN = "Stocky Escape Kit Review Test";
export const DEFAULT_SHOPIFY_APP_HANDLE = "stocky-escape-kit-1";

export type PublicBillingPlanName =
  (typeof PUBLIC_BILLING_PLANS)[keyof typeof PUBLIC_BILLING_PLANS];
export type BillingPlanName =
  | PublicBillingPlanName
  | typeof PRIVATE_TEST_BILLING_PLAN;

export const BILLING_PLAN_DETAILS = [
  {
    id: "basic",
    name: PUBLIC_BILLING_PLANS.basic,
    price: "$99/mo",
    summary: "Migration archive, parser, catalog match, and core gap reports.",
  },
  {
    id: "pro",
    name: PUBLIC_BILLING_PLANS.pro,
    price: "$199/mo",
    summary: "Adds supplier reconstruction and all export formats.",
  },
  {
    id: "plus",
    name: PUBLIC_BILLING_PLANS.plus,
    price: "$299/mo",
    summary: "Adds multi-location reporting and priority checklist output.",
  },
] as const;

export const PUBLIC_BILLING_PLAN_NAMES = Object.values(
  PUBLIC_BILLING_PLANS,
) as PublicBillingPlanName[];

export const BILLING_PLAN_NAMES: BillingPlanName[] = [
  ...PUBLIC_BILLING_PLAN_NAMES,
  PRIVATE_TEST_BILLING_PLAN,
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

export function getActiveBillingName(check: BillingCheckResponseObject) {
  return getActiveBillingSubscription(check)?.name ?? null;
}

export function hasActiveBillingSubscription(check: BillingCheckResponseObject) {
  return getActiveBillingSubscription(check) !== null;
}

export function getPlanSelectionUrl(shop: string) {
  const storeHandle = shop.replace(/\.myshopify\.com$/i, "");
  const appHandle =
    process.env.SHOPIFY_APP_HANDLE?.trim() || DEFAULT_SHOPIFY_APP_HANDLE;

  return `https://admin.shopify.com/store/${encodeURIComponent(
    storeHandle,
  )}/charges/${encodeURIComponent(appHandle)}/pricing_plans`;
}

function getActiveBillingSubscription(check: BillingCheckResponseObject) {
  return (
    check.appSubscriptions.find(
      (subscription) =>
        subscription.status === "ACTIVE" &&
        isValidBillingPlan(subscription.name),
    ) ?? null
  );
}

export async function updateStoreBillingStatus({
  shop,
  billingCheck,
}: {
  shop: string;
  billingCheck: BillingCheckResponseObject;
}) {
  const billingStatus = hasActiveBillingSubscription(billingCheck)
    ? BillingStatus.ACTIVE
    : BillingStatus.NOT_STARTED;

  await db.store.updateMany({
    where: { shop },
    data: { billingStatus },
  });

  return billingStatus;
}
