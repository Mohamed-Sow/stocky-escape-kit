import type { BillingCheckResponseObject } from "@shopify/shopify-api";
import { BillingStatus } from "@prisma/client";
import db from "../db.server";

export const BILLING_PLANS = {
  basic: "Stocky Escape Kit Basic",
  pro: "Stocky Escape Kit Pro",
  plus: "Stocky Escape Kit Plus",
} as const;

export type BillingPlanName =
  (typeof BILLING_PLANS)[keyof typeof BILLING_PLANS];

export const BILLING_PLAN_DETAILS = [
  {
    id: "basic",
    name: BILLING_PLANS.basic,
    price: "$99",
    summary: "Migration archive, parser, catalog match, and core gap reports.",
  },
  {
    id: "pro",
    name: BILLING_PLANS.pro,
    price: "$199",
    summary: "Adds supplier reconstruction and all export formats.",
  },
  {
    id: "plus",
    name: BILLING_PLANS.plus,
    price: "$299",
    summary: "Adds multi-location reporting and priority checklist output.",
  },
] as const;

export const BILLING_PLAN_NAMES = Object.values(
  BILLING_PLANS,
) as BillingPlanName[];

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
  return (
    check.oneTimePurchases[0]?.name ?? check.appSubscriptions[0]?.name ?? null
  );
}

export async function updateStoreBillingStatus({
  shop,
  billingCheck,
}: {
  shop: string;
  billingCheck: BillingCheckResponseObject;
}) {
  const billingStatus = billingCheck.hasActivePayment
    ? BillingStatus.ACTIVE
    : BillingStatus.NOT_STARTED;

  await db.store.updateMany({
    where: { shop },
    data: { billingStatus },
  });

  return billingStatus;
}
