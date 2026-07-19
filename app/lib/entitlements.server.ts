import { BillingStatus, ExportType } from "@prisma/client";
import type { PartnerBillingCheck } from "../models/billing.server";

export type BillingTier = "basic" | "pro" | "plus" | "review";

export type PlanEntitlements = {
  tier: BillingTier;
  label: string;
  maxFilesPerBatch: number;
  maxFileBytes: number;
  maxBatchBytes: number;
  maxStoredBytes: number;
  maxRowsPerFile: number;
  maxRowsPerBatch: number;
  exports: readonly ExportType[];
  reviewKit: boolean;
  locationAudit: boolean;
  priorityChecklist: boolean;
};

export type BillingAccess = {
  active: boolean;
  tier: BillingTier;
  entitlements: PlanEntitlements;
  usingLastVerifiedStatus: boolean;
};

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const BILLING_PROOF_GRACE_MS = 24 * 60 * 60 * 1_000;
const ALL_EXPORTS = Object.values(ExportType);

const PLAN_ENTITLEMENTS: Record<BillingTier, PlanEntitlements> = {
  basic: {
    tier: "basic",
    label: "Basic",
    maxFilesPerBatch: 10,
    maxFileBytes: 5 * MIB,
    maxBatchBytes: 10 * MIB,
    maxStoredBytes: 100 * MIB,
    maxRowsPerFile: 25_000,
    maxRowsPerBatch: 40_000,
    exports: ALL_EXPORTS,
    reviewKit: true,
    locationAudit: true,
    priorityChecklist: true,
  },
  pro: {
    tier: "pro",
    label: "Pro",
    maxFilesPerBatch: 20,
    maxFileBytes: 8 * MIB,
    maxBatchBytes: 15 * MIB,
    maxStoredBytes: 250 * MIB,
    maxRowsPerFile: 35_000,
    maxRowsPerBatch: 60_000,
    exports: ALL_EXPORTS,
    reviewKit: true,
    locationAudit: true,
    priorityChecklist: true,
  },
  plus: {
    tier: "plus",
    label: "Plus",
    maxFilesPerBatch: 30,
    maxFileBytes: 10 * MIB,
    maxBatchBytes: 20 * MIB,
    maxStoredBytes: 500 * MIB,
    maxRowsPerFile: 50_000,
    maxRowsPerBatch: 75_000,
    exports: ALL_EXPORTS,
    reviewKit: true,
    locationAudit: true,
    priorityChecklist: true,
  },
  review: {
    tier: "review",
    label: "Review test",
    maxFilesPerBatch: 30,
    maxFileBytes: 10 * MIB,
    maxBatchBytes: 20 * MIB,
    maxStoredBytes: 500 * MIB,
    maxRowsPerFile: 50_000,
    maxRowsPerBatch: 75_000,
    exports: ALL_EXPORTS,
    reviewKit: true,
    locationAudit: true,
    priorityChecklist: true,
  },
};

export class UploadLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadLimitError";
  }
}

export function getPlanEntitlements(tier: BillingTier) {
  return PLAN_ENTITLEMENTS[tier];
}

export function resolveBillingTier(check: PartnerBillingCheck): BillingTier {
  const identities =
    check.subscription?.items.flatMap((item) => [
      item.handle ?? "",
      item.description ?? "",
    ]) ?? [];

  return resolveBillingTierFromNames(identities);
}

export function resolveBillingTierFromName(name: string | null | undefined) {
  return resolveBillingTierFromNames(name ? [name] : []);
}

export function resolveBillingAccess({
  billingCheck,
  billingStatus,
  storedPlan,
  storedCheckedAt,
  now = new Date(),
}: {
  billingCheck: PartnerBillingCheck;
  billingStatus: BillingStatus;
  storedPlan?: string | null;
  storedCheckedAt?: Date | string | null;
  now?: Date;
}): BillingAccess {
  const checkedAt = storedCheckedAt ? new Date(storedCheckedAt) : null;
  const billingProofAgeMs = checkedAt
    ? now.getTime() - checkedAt.getTime()
    : Number.NaN;
  const withinBillingProofGrace = Boolean(
    checkedAt &&
    Number.isFinite(checkedAt.getTime()) &&
    billingProofAgeMs >= 0 &&
    billingProofAgeMs <= BILLING_PROOF_GRACE_MS,
  );
  const usingLastVerifiedStatus =
    billingCheck.verified === false &&
    billingStatus === BillingStatus.ACTIVE &&
    withinBillingProofGrace;
  const active = billingCheck.active || usingLastVerifiedStatus;
  const tier = billingCheck.active
    ? resolveBillingTier(billingCheck)
    : resolveBillingTierFromName(storedPlan);

  return {
    active,
    tier,
    entitlements: getPlanEntitlements(tier),
    usingLastVerifiedStatus,
  };
}

export function canGenerateExport(
  entitlements: PlanEntitlements,
  exportType: ExportType,
) {
  return entitlements.exports.includes(exportType);
}

export function validateUploadFiles({
  files,
  entitlements,
  currentStoredBytes,
}: {
  files: File[];
  entitlements: PlanEntitlements;
  currentStoredBytes: number;
}) {
  if (files.length === 0) {
    throw new UploadLimitError("Stage at least one Stocky CSV file.");
  }

  if (files.length > entitlements.maxFilesPerBatch) {
    throw new UploadLimitError(
      `${entitlements.label} allows up to ${entitlements.maxFilesPerBatch} files in one migration run.`,
    );
  }

  const oversized = files.find((file) => file.size > entitlements.maxFileBytes);

  if (oversized) {
    throw new UploadLimitError(
      `${oversized.name || "A staged file"} exceeds the ${formatBytes(entitlements.maxFileBytes)} per-file limit for ${entitlements.label}.`,
    );
  }

  const batchBytes = files.reduce((sum, file) => sum + file.size, 0);

  if (batchBytes > entitlements.maxBatchBytes) {
    throw new UploadLimitError(
      `This run is ${formatBytes(batchBytes)}. ${entitlements.label} allows ${formatBytes(entitlements.maxBatchBytes)} per run.`,
    );
  }

  if (currentStoredBytes + batchBytes > entitlements.maxStoredBytes) {
    throw new UploadLimitError(
      `This upload would exceed the ${formatBytes(entitlements.maxStoredBytes)} stored-data allowance for ${entitlements.label}. Download what you need and reset old migration data, or change plans.`,
    );
  }

  return { batchBytes };
}

function resolveBillingTierFromNames(names: string[]): BillingTier {
  const identity = names.join(" ").toLowerCase();

  if (identity.includes("shopify-test") || identity.includes("shopify test")) {
    return "review";
  }

  if (identity.includes("plus")) {
    return "plus";
  }

  if (identity.includes("pro")) {
    return "pro";
  }

  return "basic";
}

function formatBytes(value: number) {
  if (value >= GIB) {
    return `${value / GIB} GB`;
  }

  return `${value / MIB} MB`;
}
