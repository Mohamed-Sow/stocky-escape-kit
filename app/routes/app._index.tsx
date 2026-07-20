import type {
  ExportType,
  FindingCategory,
  FindingSeverity,
  Prisma,
} from "@prisma/client";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  Link,
  useActionData,
  useFetcher,
  useLoaderData,
  useLocation,
  useNavigate,
  useNavigation,
  useParams,
} from "react-router";
import { useEffect, useRef, useState } from "react";
import db from "../db.server";
import { regenerateAuditFindings } from "../lib/audit.server";
import {
  getOwnedUploadBatch,
  requireOwnedUploadBatch,
  uploadBatchOverviewInclude,
} from "../lib/batches.server";
import {
  getCatalogVariantLimit,
  syncShopifyCatalog,
} from "../lib/catalog.server";
import {
  UploadLimitError,
  canGenerateExport,
  resolveBillingAccess,
} from "../lib/entitlements.server";
import {
  DELETE_RUN_CONFIRMATION,
  DeleteRunConfirmationError,
  MigrationRunNotFoundError,
  RESET_CONFIRMATION,
  ResetConfirmationError,
  deleteStoreMigrationRun,
  resetStoreMigrationData,
} from "../lib/reset.server";
import {
  RequestSizeLimitError,
  readFormDataWithinLimit,
} from "../lib/request-size.server";
import { resolveFindingsPage, resolveRunHistoryPage } from "../lib/pagination";
import {
  resolveStockySourceCoverage,
  stockyReportTypeLabel,
} from "../lib/source-coverage";
import { getUploadedFiles, importStockyCsvFiles } from "../lib/uploads.server";
import {
  BILLING_PLAN_DETAILS,
  getActiveBillingName,
  getPartnerBillingCheckForAdmin,
  getPlanSelectionUrl,
  updateStoreBillingStatus,
} from "../models/billing.server";
import { upsertInstalledStore } from "../models/store.server";
import { authenticate } from "../shopify.server";
import styles from "../styles/app-dashboard.module.css";

type ActionData = {
  status: "success" | "partial" | "error";
  message: string;
  batchId?: string;
};

const VIEWS = ["overview", "files", "findings", "exports", "settings"] as const;
type View = (typeof VIEWS)[number];

const EXPORT_TYPES = [
  "ARCHIVE_CSV",
  "SKU_GAP_REPORT",
  "SUPPLIER_RECONSTRUCTION_REPORT",
  "MIGRATION_CHECKLIST",
] as const satisfies readonly ExportType[];

const FINDING_SEVERITIES = [
  "CRITICAL",
  "WARNING",
  "INFO",
] as const satisfies readonly FindingSeverity[];

const FINDING_CATEGORIES = [
  "MISSING_SKU",
  "UNMATCHED_SHOPIFY_SKU",
  "DUPLICATE_SKU",
  "MISSING_COST",
  "MISSING_BARCODE",
  "MISSING_VENDOR",
  "LOCATION_MISMATCH",
  "OPEN_PURCHASE_ORDER_INDICATOR",
  "SUPPLIER_RECONSTRUCTION_CANDIDATE",
  "PARSE_ERROR",
] as const satisfies readonly FindingCategory[];

const DISPLAY_ACRONYMS = new Set([
  "api",
  "csv",
  "id",
  "po",
  "pos",
  "sku",
  "ui",
]);

const STATUS_LABELS: Record<string, string> = {
  IMPORTED: "Preserved",
};

const EXPORT_DETAILS: Record<
  ExportType,
  { label: string; description: string }
> = {
  ARCHIVE_CSV: {
    label: "Parsed archive",
    description:
      "Every normalized row with its raw values, source file, and checksum evidence.",
  },
  SKU_GAP_REPORT: {
    label: "Audit findings",
    description:
      "Every critical, warning, and informational finding for this run.",
  },
  SUPPLIER_RECONSTRUCTION_REPORT: {
    label: "Supplier evidence",
    description:
      "Vendor and supplier hints preserved from the selected Stocky files.",
  },
  MIGRATION_CHECKLIST: {
    label: "Migration checklist",
    description:
      "A concise status and next-action list for review and handoff.",
  },
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, redirect, session } = await authenticate.admin(request);
  const store = await upsertInstalledStore({
    shop: session.shop,
    scopes: session.scope ?? null,
  });
  const billingCheck = await getPartnerBillingCheckForAdmin({
    admin,
    shop: session.shop,
  });
  const billingStatus = await updateStoreBillingStatus({
    shop: session.shop,
    billingCheck,
  });
  const billingAccess = resolveBillingAccess({
    billingCheck,
    billingStatus,
    storedPlan: store.billingPlan,
    storedCheckedAt: store.billingCheckedAt,
  });

  if (!billingAccess.active && billingStatus !== "CANCELED") {
    throw redirect(getPlanSelectionUrl(session.shop), { target: "_top" });
  }

  const url = new URL(request.url);
  const pageNotice =
    url.searchParams.get("notice") === "run-deleted"
      ? ({
          status: "success",
          message:
            "The selected migration run and its stored evidence were permanently deleted. Other runs and app settings were preserved.",
        } as const)
      : null;
  const requestedBatchId = url.searchParams.get("batch");
  const [batchTotal, latestSyncAttempt, storageAggregate] = await Promise.all([
    db.uploadBatch.count({ where: { storeId: store.id } }),
    db.shopifyCatalogSnapshot.findFirst({
      where: { storeId: store.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        syncStatus: true,
        productCount: true,
        variantCount: true,
        inventoryItemCount: true,
        inventoryLevelCount: true,
        locationCount: true,
        errorMessage: true,
        syncedAt: true,
        createdAt: true,
      },
    }),
    db.uploadedFile.aggregate({
      where: { batch: { storeId: store.id } },
      _sum: { rawContentByteLength: true },
    }),
  ]);
  const runHistory = resolveRunHistoryPage(
    url.searchParams.get("runsPage"),
    batchTotal,
  );
  const batches = await db.uploadBatch.findMany({
    where: { storeId: store.id },
    orderBy: { createdAt: "desc" },
    skip: runHistory.skip,
    take: runHistory.pageSize,
    include: uploadBatchOverviewInclude,
  });
  const selectedBatch = requestedBatchId
    ? await requireOwnedUploadBatch({
        storeId: store.id,
        batchId: requestedBatchId,
      })
    : (batches[0] ?? null);
  const displaySnapshot = selectedBatch
    ? selectedBatch.auditSnapshot
    : latestSyncAttempt;
  const findingSeverity = FINDING_SEVERITIES.find(
    (severity) => severity === url.searchParams.get("findingSeverity"),
  );
  const findingCategory = FINDING_CATEGORIES.find(
    (category) => category === url.searchParams.get("findingCategory"),
  );
  const findingQuery = (url.searchParams.get("findingQuery") ?? "")
    .trim()
    .slice(0, 120);
  const baseFindingWhere: Prisma.AuditFindingWhereInput = {
    storeId: store.id,
    batchId: selectedBatch?.id ?? "__no_batch__",
    category: billingAccess.entitlements.locationAudit
      ? undefined
      : { not: "LOCATION_MISMATCH" },
  };
  const filteredFindingWhere: Prisma.AuditFindingWhereInput = {
    ...baseFindingWhere,
    ...(findingSeverity ? { severity: findingSeverity } : {}),
    ...(findingCategory ? { category: findingCategory } : {}),
    ...(findingQuery
      ? {
          OR: [
            { sku: { contains: findingQuery, mode: "insensitive" } },
            { title: { contains: findingQuery, mode: "insensitive" } },
            { message: { contains: findingQuery, mode: "insensitive" } },
            {
              recommendedAction: {
                contains: findingQuery,
                mode: "insensitive",
              },
            },
          ],
        }
      : {}),
  };
  const [findingGroups, filteredFindingTotal, exportJobs] = await Promise.all([
    db.auditFinding.groupBy({
      by: ["severity", "category"],
      where: baseFindingWhere,
      _count: { _all: true },
    }),
    db.auditFinding.count({ where: filteredFindingWhere }),
    db.exportJob.findMany({
      where: selectedBatch
        ? { storeId: store.id, batchId: selectedBatch.id }
        : { storeId: store.id, batchId: "__no_batch__" },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);
  const findingResults = resolveFindingsPage(
    url.searchParams.get("findingsPage"),
    filteredFindingTotal,
  );
  const findings = await db.auditFinding.findMany({
    where: filteredFindingWhere,
    orderBy: [{ severity: "asc" }, { createdAt: "desc" }],
    skip: findingResults.skip,
    take: findingResults.pageSize,
  });
  const severityCounts = { CRITICAL: 0, WARNING: 0, INFO: 0 };

  for (const group of findingGroups) {
    severityCounts[group.severity] += group._count._all;
  }
  const findingTotal = Object.values(severityCounts).reduce(
    (total, count) => total + count,
    0,
  );

  return {
    shop: session.shop,
    scopes: session.scope ?? "read_products,read_inventory,read_locations",
    billing: {
      active: billingAccess.active,
      status: billingStatus,
      activePlan: getActiveBillingName(billingCheck) ?? store.billingPlan,
      usingLastVerifiedStatus: billingAccess.usingLastVerifiedStatus,
    },
    entitlements: billingAccess.entitlements,
    storage: {
      usedBytes: storageAggregate._sum.rawContentByteLength ?? 0,
      maxBytes: billingAccess.entitlements.maxStoredBytes,
    },
    catalogVariantLimit: getCatalogVariantLimit(),
    billingPlans: BILLING_PLAN_DETAILS,
    runHistory,
    batches: batches.map(serializeBatch),
    selectedBatch: selectedBatch ? serializeBatch(selectedBatch) : null,
    latestSnapshot: displaySnapshot
      ? {
          id: displaySnapshot.id,
          status: displaySnapshot.syncStatus,
          productCount: displaySnapshot.productCount,
          variantCount: displaySnapshot.variantCount,
          inventoryItemCount: displaySnapshot.inventoryItemCount,
          inventoryLevelCount: displaySnapshot.inventoryLevelCount,
          locationCount: displaySnapshot.locationCount,
          errorMessage: displaySnapshot.errorMessage,
          syncedAt: displaySnapshot.syncedAt?.toISOString() ?? null,
        }
      : null,
    latestSyncAttempt: latestSyncAttempt
      ? {
          id: latestSyncAttempt.id,
          status: latestSyncAttempt.syncStatus,
          errorMessage: latestSyncAttempt.errorMessage,
          createdAt: latestSyncAttempt.createdAt.toISOString(),
        }
      : null,
    severityCounts,
    findingTotal,
    findingFilters: {
      severity: findingSeverity ?? "ALL",
      category: findingCategory ?? "ALL",
      query: findingQuery,
    },
    findingResults,
    findingGroups: findingGroups.map((group) => ({
      severity: group.severity,
      category: group.category,
      count: group._count._all,
    })),
    findings: findings.map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      category: finding.category,
      sku: finding.sku,
      title: finding.title,
      message: finding.message,
      recommendedAction: finding.recommendedAction,
      source: finding.source,
    })),
    exports: EXPORT_TYPES.map((type) => ({
      type,
      ...EXPORT_DETAILS[type],
      available: canGenerateExport(billingAccess.entitlements, type),
    })),
    exportJobs: exportJobs.map((job) => ({
      id: job.id,
      type: job.exportType,
      status: job.status,
      completedAt: job.completedAt?.toISOString() ?? null,
      errorMessage: job.errorMessage,
    })),
    resetConfirmation: RESET_CONFIRMATION,
    deleteRunConfirmation: DELETE_RUN_CONFIRMATION,
    pageNotice,
  };
};

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ActionData | Response> => {
  const { admin, redirect, session } = await authenticate.admin(request);
  const store = await upsertInstalledStore({
    shop: session.shop,
    scopes: session.scope ?? null,
  });
  const billingCheck = await getPartnerBillingCheckForAdmin({
    admin,
    shop: session.shop,
  });
  const billingStatus = await updateStoreBillingStatus({
    shop: session.shop,
    billingCheck,
  });
  const billingAccess = resolveBillingAccess({
    billingCheck,
    billingStatus,
    storedPlan: store.billingPlan,
    storedCheckedAt: store.billingCheckedAt,
  });
  const requestLimit = billingAccess.active
    ? billingAccess.entitlements.maxBatchBytes + 2 * 1024 * 1024
    : 1024 * 1024;

  let formData: FormData;

  try {
    formData = await readFormDataWithinLimit(request, requestLimit);
  } catch (error) {
    if (!(error instanceof RequestSizeLimitError)) throw error;

    return {
      status: "error",
      message: billingAccess.active
        ? `The upload request exceeds the ${formatBytes(billingAccess.entitlements.maxBatchBytes)} run limit for ${billingAccess.entitlements.label}.`
        : "Reactivate the subscription before uploading files.",
    };
  }
  const intent = String(formData.get("intent") ?? "");

  if (intent === "select_plan") {
    return redirect(getPlanSelectionUrl(session.shop), { target: "_top" });
  }

  if (intent === "reset_store_data") {
    try {
      const result = await resetStoreMigrationData({
        storeId: store.id,
        confirmation: String(formData.get("confirmation") ?? ""),
      });
      return {
        status: "success",
        message: `Deleted ${result.uploadBatches} migration runs, ${result.catalogSnapshots} catalog snapshots, ${result.auditFindings} findings, and ${result.exportJobs} export records. Installation and billing were preserved.`,
      };
    } catch (error) {
      if (!(error instanceof ResetConfirmationError)) {
        console.error("Store migration-data reset failed.", error);
      }

      return {
        status: "error",
        message:
          error instanceof ResetConfirmationError
            ? error.message
            : "Migration data could not be reset. Try again or contact support.",
      };
    }
  }

  if (intent === "delete_migration_run") {
    try {
      await deleteStoreMigrationRun({
        storeId: store.id,
        batchId: String(formData.get("batchId") ?? ""),
        confirmation: String(formData.get("confirmation") ?? ""),
      });
      return redirect("/app/files?notice=run-deleted", { target: "_self" });
    } catch (error) {
      if (
        !(error instanceof DeleteRunConfirmationError) &&
        !(error instanceof MigrationRunNotFoundError)
      ) {
        console.error("Migration run deletion failed.", error);
      }

      return {
        status: "error",
        message:
          error instanceof DeleteRunConfirmationError ||
          error instanceof MigrationRunNotFoundError
            ? error.message
            : "The migration run could not be deleted. Try again or contact support.",
      };
    }
  }

  if (!billingAccess.active) {
    return {
      status: "error",
      message: "Choose an active Shopify App Pricing subscription first.",
    };
  }

  if (intent === "upload_csv") {
    const files = getUploadedFiles(formData);

    if (files.length === 0) {
      return {
        status: "error",
        message: "Stage at least one Stocky CSV file.",
      };
    }

    const storageAggregate = await db.uploadedFile.aggregate({
      where: { batch: { storeId: store.id } },
      _sum: { rawContentByteLength: true },
    });

    try {
      const result = await importStockyCsvFiles({
        storeId: store.id,
        files,
        entitlements: billingAccess.entitlements,
        currentStoredBytes: storageAggregate._sum.rawContentByteLength ?? 0,
        includeLocationMismatches: billingAccess.entitlements.locationAudit,
      });
      return {
        status:
          result.failedFileCount === 0
            ? "success"
            : result.importedRowCount > 0
              ? "partial"
              : "error",
        batchId: result.batchId,
        message: `Processed ${result.fileCount} files as one run: ${result.importedRowCount} rows parsed and preserved, ${result.warningCount} warnings, ${result.failedFileCount} failed file${result.failedFileCount === 1 ? "" : "s"}.`,
      };
    } catch (error) {
      if (!(error instanceof UploadLimitError)) {
        console.error("Stocky CSV upload failed.", error);
      }

      return {
        status: "error",
        message:
          error instanceof UploadLimitError
            ? error.message
            : "The upload could not be completed. Try again or contact support with the run time and filenames.",
      };
    }
  }

  if (intent === "sync_catalog") {
    const batchId = String(formData.get("batchId") ?? "");
    const batch = await requireOwnedUploadBatch({ storeId: store.id, batchId });
    const snapshot = await syncShopifyCatalog({ admin, storeId: store.id });

    if (snapshot.syncStatus === "FAILED") {
      return {
        status: "error",
        message: snapshot.errorMessage ?? "Shopify catalog sync failed.",
      };
    }

    const audit = await regenerateAuditFindings({
      storeId: store.id,
      batchId: batch.id,
      snapshotId: snapshot.id,
      includeLocationMismatches: billingAccess.entitlements.locationAudit,
    });
    return {
      status: "success",
      batchId: batch.id,
      message: `Synced ${snapshot.variantCount} variants across ${snapshot.locationCount} locations and generated ${audit.created} findings for this run.`,
    };
  }

  return { status: "error", message: "Unknown action." };
};

export default function Index() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const location = useLocation();
  const navigate = useNavigate();
  const params = useParams();
  const url = new URLSearchParams(location.search);
  const requestedView = params.view ?? url.get("view");
  const view: View = VIEWS.includes(requestedView as View)
    ? (requestedView as View)
    : "overview";
  const selectedBatchId = data.selectedBatch?.id ?? null;
  const shared = {
    data,
    selectedBatchId,
    onViewChange: (nextView: View) =>
      navigate(viewHref(nextView, selectedBatchId, data.runHistory.page)),
  };

  return (
    <s-page heading="Stocky Escape Kit">
      <div className={styles.shell}>
        <header className={styles.workspaceHeader}>
          <div>
            <p className={styles.eyebrow}>
              Stocky shutdown migration workspace
            </p>
            <h2 className={styles.title}>{viewLabel(view)}</h2>
            <p className={styles.subtitle}>
              Preserve the source, prove the gaps, and leave with a reviewable
              migration record.
            </p>
          </div>
          {view === "settings" ? null : (
            <RunPicker
              batches={data.batches}
              selectedBatch={data.selectedBatch}
              selectedBatchId={selectedBatchId}
              runsPage={data.runHistory.page}
              view={view}
            />
          )}
        </header>

        <nav className={styles.tabs} aria-label="Migration workspace">
          {VIEWS.map((item) => (
            <Link
              key={item}
              to={viewHref(item, selectedBatchId, data.runHistory.page)}
              className={item === view ? styles.activeTab : styles.tab}
              aria-current={item === view ? "page" : undefined}
            >
              {viewLabel(item)}
            </Link>
          ))}
        </nav>

        {!data.billing.active || data.billing.usingLastVerifiedStatus ? (
          <BillingBanner data={data} />
        ) : null}
        {data.pageNotice ? <StatusBanner data={data.pageNotice} /> : null}
        {actionData ? <StatusBanner data={actionData} /> : null}

        <main className={styles.main}>
          {view === "overview" ? <Overview {...shared} /> : null}
          {view === "files" ? <Files {...shared} /> : null}
          {view === "findings" ? <Findings {...shared} /> : null}
          {view === "exports" ? <Exports {...shared} /> : null}
          {view === "settings" ? <Settings data={data} /> : null}
        </main>
      </div>
    </s-page>
  );
}

function Overview({ data, selectedBatchId, onViewChange }: ViewProps) {
  const batch = data.selectedBatch;
  const sourceCoverage = resolveStockySourceCoverage(batch?.files ?? []);
  const missingSourceLabels = sourceCoverage.missing.map(stockyReportTypeLabel);
  const totalFindings = Object.values(data.severityCounts).reduce(
    (sum, count) => sum + count,
    0,
  );
  const nextAction = !data.billing.active
    ? {
        eyebrow: "Subscription ended",
        title: "Download your preserved source files",
        detail:
          "Original CSV files and findings remain readable. Use Settings if you want to delete the stored migration data.",
        view: "files" as const,
        cta: "View preserved files",
      }
    : !batch
      ? {
          eyebrow: "Next action",
          title: "Upload your Stocky exports",
          detail:
            "Stage all related files and submit them as one migration run.",
          view: "files" as const,
          cta: "Upload Stocky files",
        }
      : !sourceCoverage.coreTypesRepresented
        ? {
            eyebrow: "Core report types needed",
            title: "Add the missing historical reports",
            detail: `Create one complete run that also includes ${missingSourceLabels.join(", ")}. Product, custom SKU, and inventory activity reports are supplemental evidence.`,
            view: "files" as const,
            cta: "Review missing reports",
          }
        : !data.latestSnapshot || data.latestSnapshot.status !== "SUCCEEDED"
          ? {
              eyebrow: "Next action",
              title: "Sync the Shopify catalog",
              detail:
                "Build a complete, read-only product and location snapshot before matching this run.",
              view: "files" as const,
              cta: "Sync Shopify catalog",
            }
          : data.severityCounts.CRITICAL > 0
            ? {
                eyebrow: "Critical next action",
                title: "Review critical findings",
                detail:
                  "Resolve identity and matching gaps before relying on the export kit.",
                view: "findings" as const,
                cta: "Review critical findings",
              }
            : totalFindings > 0
              ? {
                  eyebrow: "Review next",
                  title: "Review the remaining warnings and evidence",
                  detail:
                    "No critical blockers remain. Confirm the non-blocking issues before handoff.",
                  view: "findings" as const,
                  cta: "Review findings",
                }
              : {
                  eyebrow: "Run ready",
                  title: "Download the migration record",
                  detail:
                    "The current audit has no findings. Preserve the reports and source checksums for handoff.",
                  view: "exports" as const,
                  cta: "Download migration package",
                };
  const nextActionHref = viewHref(
    nextAction.view,
    selectedBatchId,
    data.runHistory.page,
    nextAction.view === "findings" && data.severityCounts.CRITICAL > 0
      ? { findingSeverity: "CRITICAL" }
      : undefined,
  );

  return (
    <div className={styles.stack}>
      <section className={styles.nextAction}>
        <div>
          <p className={styles.eyebrow}>{nextAction.eyebrow}</p>
          <h3>{nextAction.title}</h3>
          <p>{nextAction.detail}</p>
        </div>
        <Link
          to={nextActionHref}
          className={styles.primaryButton}
        >
          {nextAction.cta}
        </Link>
      </section>
      <section className={styles.metricGrid} aria-label="Migration progress">
        <Metric
          label="Files preserved"
          value={batch?.fileCount ?? 0}
          detail={batch ? formatDate(batch.createdAt) : "No run yet"}
        />
        <Metric
          label="Rows parsed"
          value={batch?.importedRowCount ?? 0}
          detail={`${batch?.warningCount ?? 0} parser warnings`}
        />
        <Metric
          label="Audit findings"
          value={totalFindings}
          detail={`${data.severityCounts.CRITICAL} critical`}
        />
        <Metric
          label="Shopify variants"
          value={data.latestSnapshot?.variantCount ?? 0}
          detail={
            data.latestSnapshot?.syncedAt
              ? `Synced ${formatDate(data.latestSnapshot.syncedAt)}`
              : "Catalog not synced"
          }
        />
      </section>
      <div className={styles.twoColumn}>
        <section className={styles.panel}>
          <div className={styles.sectionHeading}>
            <div>
              <p className={styles.eyebrow}>Current run</p>
              <h3>
                {batch ? formatRunName(batch.createdAt) : "No migration run"}
              </h3>
            </div>
            <button
              type="button"
              className={styles.textButton}
              onClick={() => onViewChange("files")}
            >
              View files
            </button>
          </div>
          {batch ? (
            <dl className={styles.definitionList}>
              <div>
                <dt>Status</dt>
                <dd>
                  <StatusPill value={batch.status} />
                </dd>
              </div>
              <div>
                <dt>Files</dt>
                <dd>{batch.fileCount}</dd>
              </div>
              <div>
                <dt>Parsed rows</dt>
                <dd>{batch.importedRowCount}</dd>
              </div>
              <div>
                <dt>Warnings</dt>
                <dd>{batch.warningCount}</dd>
              </div>
              <div>
                <dt>Core report types</dt>
                <dd>
                  {sourceCoverage.covered.length} of {sourceCoverage.total}{" "}
                  report types
                </dd>
              </div>
            </dl>
          ) : (
            <EmptyState
              title="No Stocky files yet"
              detail="Create one run from related exports so findings and reports stay traceable."
            />
          )}
        </section>
        <section className={styles.panel}>
          <div className={styles.sectionHeading}>
            <div>
              <p className={styles.eyebrow}>Catalog status</p>
              <h3>Read-only Shopify snapshot</h3>
            </div>
          </div>
          {data.latestSnapshot ? (
            <dl className={styles.definitionList}>
              <div>
                <dt>Products</dt>
                <dd>{data.latestSnapshot.productCount}</dd>
              </div>
              <div>
                <dt>Variants</dt>
                <dd>{data.latestSnapshot.variantCount}</dd>
              </div>
              <div>
                <dt>Inventory items</dt>
                <dd>{data.latestSnapshot.inventoryItemCount}</dd>
              </div>
              <div>
                <dt>Locations</dt>
                <dd>{data.latestSnapshot.locationCount}</dd>
              </div>
              <div>
                <dt>Completeness</dt>
                <dd>
                  {data.latestSnapshot.status === "SUCCEEDED"
                    ? "Complete"
                    : "Not verified"}
                </dd>
              </div>
            </dl>
          ) : (
            <EmptyState
              title="No catalog snapshot"
              detail="Sync from Files after choosing a migration run."
            />
          )}
        </section>
      </div>
      <section className={styles.panel}>
        <p className={styles.eyebrow}>Operational cutover</p>
        <h3>The archive is only half of the migration</h3>
        <p>
          These actions happen in Shopify or with your staff, so this read-only
          app cannot mark them complete for you:
        </p>
        <ul className={styles.guidanceList}>
          <li>
            Stop creating Stocky purchase orders about 14 days before August 31,
            then receive and close everything possible.
          </li>
          <li>
            Use the Open PO files in Exports to recreate only verified remaining
            quantities from in-flight orders as Shopify draft line items;
            historical purchase orders cannot be imported as history.
          </li>
          <li>
            Test a Shopify purchase order, transfer, and inventory adjustment,
            including Shopify POS workflows your staff use.
          </li>
          <li>
            Train the inventory team, remove the Stocky POS tile, and update any
            integration that still depends on Stocky APIs.
          </li>
        </ul>
        <p>
          <a
            href="https://help.shopify.com/en/manual/products/inventory/transitioning-from-stocky"
            target="_blank"
            rel="noreferrer"
          >
            Review Shopify&apos;s current Stocky cutover guidance
          </a>
          .
        </p>
      </section>
    </div>
  );
}

function Files({ data, selectedBatchId }: ViewProps) {
  const navigate = useNavigate();
  const sourceCoverage = resolveStockySourceCoverage(
    data.selectedBatch?.files ?? [],
  );
  const sourceCoverageDescription = data.selectedBatch
    ? [
        `${sourceCoverage.covered.length} of ${sourceCoverage.total} core reports.`,
        sourceCoverage.coreTypesRepresented
          ? "Completed purchase orders, stocktakes, and historical stock-on-hand or cost reports are represented."
          : `Still needed in one complete run: ${sourceCoverage.missing.map(stockyReportTypeLabel).join(", ")}.`,
        sourceCoverage.supplementalCovered.length > 0
          ? `Supplemental evidence included: ${sourceCoverage.supplementalCovered.map(stockyReportTypeLabel).join(", ")}.`
          : "",
        sourceCoverage.coreTypesRepresented
          ? "Report presence does not prove that every date range or record was exported."
          : "A header-only CSV still counts when Stocky returns no rows; a blank file does not.",
      ]
        .filter(Boolean)
        .join(" ")
    : null;
  return (
    <div className={styles.stack}>
      <section className={styles.panel}>
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>Selected run</p>
            <h3>Preserved source files</h3>
          </div>
          {data.selectedBatch ? (
            <div className={styles.runActions}>
              <CatalogSync
                batchId={data.selectedBatch.id}
                disabled={!data.billing.active}
              />
              <DeleteRunControl
                batchId={data.selectedBatch.id}
                confirmationText={data.deleteRunConfirmation}
              />
            </div>
          ) : null}
        </div>
        {sourceCoverageDescription ? (
          <p
            aria-label={`Selected run coverage: ${sourceCoverageDescription}`}
            className={styles.inlineNotice}
            role="note"
          >
            <strong>Selected run coverage:</strong> {sourceCoverageDescription}
          </p>
        ) : null}
        {data.selectedBatch ? (
          <FilesTable files={data.selectedBatch.files} />
        ) : (
          <EmptyState
            title="No run selected"
            detail="Stage related Stocky CSV exports below and upload them together."
          />
        )}
      </section>
      {data.latestSyncAttempt?.status === "FAILED" ? (
        <div className={styles.errorNotice} role="alert">
          <strong>Latest Shopify sync failed.</strong>{" "}
          {data.latestSyncAttempt.errorMessage ??
            "Shopify did not return a complete catalog snapshot."}{" "}
          {data.latestSnapshot?.status === "SUCCEEDED"
            ? "The selected run remains linked to its last complete snapshot; retry before relying on a fresh audit."
            : "Retry before relying on this run's audit."}
        </div>
      ) : null}
      <FileStager key={selectedBatchId ?? "new-run"} data={data} />
      <section className={styles.panel}>
        <p className={styles.eyebrow}>Before August 31, 2026</p>
        <h3>Preserve the Stocky history that will not migrate automatically</h3>
        <ul className={styles.guidanceList}>
          <li>Completed purchase order reports</li>
          <li>Stocktake history</li>
          <li>Historical stock-on-hand or cost reports</li>
          <li>
            Helpful supplemental evidence when available: product or custom SKU
            reports, vendor or supplier-reference reports, and inventory
            activity
          </li>
          <li>
            Supplier evidence from purchase orders or custom SKU reports; Stocky
            supplier records cannot be exported directly
          </li>
        </ul>
        <p>
          <a
            href="https://help.shopify.com/en/manual/products/inventory/transitioning-from-stocky"
            target="_blank"
            rel="noreferrer"
          >
            Review Shopify&apos;s current export and cutover instructions
          </a>
          .
        </p>
        <p className={styles.inlineNotice}>
          Catalog audits currently verify stores with up to{" "}
          {data.catalogVariantLimit.toLocaleString()} Shopify variants. Larger
          catalogs stop before findings are generated so partial results cannot
          look complete; contact support before relying on this app for one.
        </p>
        <p className={styles.inlineNotice}>
          The location check compares location names found in Stocky reports
          with the store&apos;s current Shopify location names. It does not
          claim that a specific SKU is stocked at that location or compare
          on-hand quantities.
        </p>
      </section>
      <section className={styles.panel}>
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>History</p>
            <h3>Migration runs</h3>
          </div>
          <span className={styles.countLabel}>
            {data.runHistory.total.toLocaleString()} total
          </span>
        </div>
        {data.batches.length ? (
          <div className={styles.historyList}>
            {data.batches.map((batch) => (
              <button
                type="button"
                key={batch.id}
                onClick={() =>
                  navigate(viewHref("files", batch.id, data.runHistory.page))
                }
                className={
                  batch.id === selectedBatchId
                    ? styles.selectedHistoryRow
                    : styles.historyRow
                }
              >
                <span>
                  <strong>{formatRunName(batch.createdAt)}</strong>
                  <small>{formatDate(batch.createdAt)}</small>
                </span>
                <span>
                  {batch.fileCount} files · {batch.importedRowCount} rows
                </span>
                <StatusPill value={batch.status} />
              </button>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No upload history"
            detail="Your migration runs will appear here without replacing earlier raw archives."
          />
        )}
        {data.runHistory.pageCount > 1 ? (
          <nav
            className={styles.historyPagination}
            aria-label="Migration run history pages"
          >
            <span>
              Page {data.runHistory.page.toLocaleString()} of{" "}
              {data.runHistory.pageCount.toLocaleString()}
            </span>
            <div>
              {data.runHistory.page > 1 ? (
                <Link
                  className={styles.secondaryButton}
                  to={viewHref("files", null, data.runHistory.page - 1)}
                >
                  Newer runs
                </Link>
              ) : null}
              {data.runHistory.page < data.runHistory.pageCount ? (
                <Link
                  className={styles.secondaryButton}
                  to={viewHref("files", null, data.runHistory.page + 1)}
                >
                  Older runs
                </Link>
              ) : null}
            </div>
          </nav>
        ) : null}
      </section>
    </div>
  );
}

function FileStager({ data }: { data: LoaderData }) {
  const fetcher = useFetcher<ActionData>();
  const navigate = useNavigate();
  const [files, setFiles] = useState<File[]>([]);
  const [duplicateMessage, setDuplicateMessage] = useState<string | null>(null);
  const [limitMessage, setLimitMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stagedBytes = files.reduce((sum, file) => sum + file.size, 0);

  useEffect(() => {
    if (fetcher.data?.batchId) {
      navigate(viewHref("files", fetcher.data.batchId));
    }
  }, [fetcher.data?.batchId, navigate]);

  function stage(incoming: FileList | File[]) {
    const csv = Array.from(incoming).filter((file) =>
      file.name.toLowerCase().endsWith(".csv"),
    );
    const keys = new Set(files.map(fileKey));
    const additions = csv.filter((file) => !keys.has(fileKey(file)));
    const duplicateCount = csv.length - additions.length;
    const candidate = [...files, ...additions];
    const oversized = candidate.find(
      (file) => file.size > data.entitlements.maxFileBytes,
    );
    const candidateBytes = candidate.reduce((sum, file) => sum + file.size, 0);
    let nextLimitMessage: string | null = null;

    if (!data.billing.active) {
      nextLimitMessage = "Reactivate the subscription before staging files.";
    } else if (candidate.length > data.entitlements.maxFilesPerBatch) {
      nextLimitMessage = `${data.entitlements.label} allows ${data.entitlements.maxFilesPerBatch} files in one run.`;
    } else if (oversized) {
      nextLimitMessage = `${oversized.name} exceeds the ${formatBytes(data.entitlements.maxFileBytes)} per-file limit.`;
    } else if (candidateBytes > data.entitlements.maxBatchBytes) {
      nextLimitMessage = `The staged files exceed the ${formatBytes(data.entitlements.maxBatchBytes)} per-run limit.`;
    } else if (
      data.storage.usedBytes + candidateBytes >
      data.storage.maxBytes
    ) {
      nextLimitMessage =
        "This run would exceed stored-data capacity. Download what you need and delete an older run from Files, or change plans.";
    }

    if (!nextLimitMessage) {
      setFiles(candidate);
    }

    setLimitMessage(nextLimitMessage);
    setDuplicateMessage(
      duplicateCount
        ? `${duplicateCount} duplicate file${duplicateCount === 1 ? " was" : "s were"} not added.`
        : null,
    );
    if (inputRef.current) inputRef.current.value = "";
  }

  function submit() {
    const body = new FormData();
    body.set("intent", "upload_csv");
    files.forEach((file) => body.append("csvFiles", file));
    fetcher.submit(body, { method: "post", encType: "multipart/form-data" });
  }

  return (
    <section className={styles.panel}>
      <div className={styles.sectionHeading}>
        <div>
          <p className={styles.eyebrow}>New migration run</p>
          <h3>Stage Stocky CSV files</h3>
          <p>
            Add files in several passes or drag them here. Nothing uploads until
            you submit the run.
          </p>
        </div>
      </div>
      <div
        className={styles.dropzone}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          stage(event.dataTransfer.files);
        }}
      >
        <input
          ref={inputRef}
          id="csvFiles"
          type="file"
          accept=".csv,text/csv"
          multiple
          disabled={!data.billing.active}
          onChange={(event) => event.target.files && stage(event.target.files)}
        />
        <label htmlFor="csvFiles">
          <strong>Choose CSV files</strong>
          <span>or drag and drop Stocky exports</span>
        </label>
      </div>
      {duplicateMessage ? (
        <p className={styles.inlineNotice} role="status">
          {duplicateMessage}
        </p>
      ) : null}
      {limitMessage ? (
        <p className={styles.errorNotice} role="alert">
          {limitMessage}
        </p>
      ) : null}
      {files.length ? (
        <ul className={styles.stagedList}>
          {files.map((file) => (
            <li key={fileKey(file)}>
              <span>
                <strong>{file.name}</strong>
                <small>{formatBytes(file.size)}</small>
              </span>
              <button
                type="button"
                className={styles.textButton}
                onClick={() => {
                  setFiles((current) =>
                    current.filter((item) => fileKey(item) !== fileKey(file)),
                  );
                  setLimitMessage(null);
                }}
              >
                Remove<span className={styles.srOnly}> {file.name}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.muted}>No files staged.</p>
      )}
      <div className={styles.actionRow}>
        <button
          className={styles.primaryButton}
          type="button"
          disabled={
            !data.billing.active || !files.length || fetcher.state !== "idle"
          }
          onClick={submit}
        >
          {fetcher.state === "idle"
            ? `Upload ${files.length || ""} file${files.length === 1 ? "" : "s"}`
            : "Uploading and parsing…"}
        </button>
        <span className={styles.muted}>
          {files.length}/{data.entitlements.maxFilesPerBatch} files ·{" "}
          {formatBytes(data.entitlements.maxFileBytes)} per file ·{" "}
          {formatBytes(stagedBytes)}/
          {formatBytes(data.entitlements.maxBatchBytes)} this run ·{" "}
          {data.entitlements.maxRowsPerBatch.toLocaleString()} parsed rows max ·{" "}
          {formatBytes(data.storage.usedBytes)}/
          {formatBytes(data.storage.maxBytes)} source CSV storage
        </span>
      </div>
      {fetcher.data ? <StatusBanner data={fetcher.data} /> : null}
    </section>
  );
}

function CatalogSync({
  batchId,
  disabled,
}: {
  batchId: string;
  disabled: boolean;
}) {
  const navigation = useNavigation();
  const isSyncing =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "sync_catalog" &&
    navigation.formData?.get("batchId") === batchId;
  return (
    <Form method="post">
      <input type="hidden" name="intent" value="sync_catalog" />
      <input type="hidden" name="batchId" value={batchId} />
      <button
        className={styles.secondaryButton}
        type="submit"
        disabled={isSyncing || disabled}
        title={disabled ? "Reactivate the subscription to sync." : undefined}
      >
        {isSyncing ? "Syncing…" : "Sync Shopify and audit"}
      </button>
    </Form>
  );
}

function DeleteRunControl({
  batchId,
  confirmationText,
}: {
  batchId: string;
  confirmationText: string;
}) {
  const [armed, setArmed] = useState(false);
  const [confirmation, setConfirmation] = useState("");

  if (!armed) {
    return (
      <button
        type="button"
        className={styles.textButton}
        onClick={() => setArmed(true)}
      >
        Delete selected run
      </button>
    );
  }

  return (
    <Form method="post" className={styles.deleteRunForm}>
      <input type="hidden" name="intent" value="delete_migration_run" />
      <input type="hidden" name="batchId" value={batchId} />
      <p>
        Deletes only this run&apos;s files, parsed rows, findings, catalog
        snapshot, and export history. Other runs and app settings stay.
      </p>
      <label>
        Type <strong>{confirmationText}</strong>
        <input
          name="confirmation"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          autoComplete="off"
        />
      </label>
      <div className={styles.actionRow}>
        <button
          type="submit"
          className={styles.dangerButton}
          disabled={confirmation !== confirmationText}
        >
          Permanently delete this run
        </button>
        <button
          type="button"
          className={styles.textButton}
          onClick={() => {
            setArmed(false);
            setConfirmation("");
          }}
        >
          Cancel
        </button>
      </div>
    </Form>
  );
}

function FilesTable({ files }: { files: SerializedBatch["files"] }) {
  return (
    <div className={styles.tableWrap}>
      <table>
        <caption className={styles.srOnly}>
          Files and raw archive downloads for the selected migration run
        </caption>
        <thead>
          <tr>
            <th scope="col">File</th>
            <th scope="col">Type</th>
            <th scope="col">Status</th>
            <th scope="col">Rows</th>
            <th scope="col">Parser warnings</th>
            <th scope="col">Raw archive</th>
          </tr>
        </thead>
        <tbody>
          {files.map((file) => (
            <tr key={file.id}>
              <td>
                <strong>{file.filename}</strong>
                {file.errorMessage ? (
                  <small className={styles.errorText}>
                    {file.errorMessage}
                  </small>
                ) : null}
              </td>
              <td>{reportTypeLabel(file.reportType)}</td>
              <td>
                <StatusPill value={file.status} />
              </td>
              <td>{file.rowCount}</td>
              <td>{file.warningCount}</td>
              <td>
                {file.rawCsvDownloadHref ? (
                  <AuthenticatedDownloadButton
                    label={`Download · ${formatBytes(file.rawContentByteLength ?? 0)}`}
                    path={file.rawCsvDownloadHref}
                  />
                ) : (
                  "Unavailable"
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Findings({ data, selectedBatchId }: ViewProps) {
  return (
    <div className={styles.stack}>
      <section className={styles.metricGrid}>
        <Metric
          label="Critical"
          value={data.severityCounts.CRITICAL}
          detail="Blocks confident matching"
        />
        <Metric
          label="Warnings"
          value={data.severityCounts.WARNING}
          detail="Needs merchant review"
        />
        <Metric
          label="Information"
          value={data.severityCounts.INFO}
          detail="Evidence and follow-up"
        />
      </section>
      <section className={styles.panel}>
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>Selected run</p>
            <h3>Audit findings</h3>
          </div>
          <span className={styles.countLabel}>
            {data.findings.length} shown of {data.findingResults.total}
            {data.findingResults.total !== data.findingTotal
              ? ` matching · ${data.findingTotal} total`
              : ""}
          </span>
        </div>
        <Form
          key={`${data.findingFilters.query}|${data.findingFilters.severity}|${data.findingFilters.category}`}
          method="get"
          className={styles.filters}
          aria-label="Filter findings"
        >
          {selectedBatchId ? (
            <input type="hidden" name="batch" value={selectedBatchId} />
          ) : null}
          {data.runHistory.page > 1 ? (
            <input type="hidden" name="runsPage" value={data.runHistory.page} />
          ) : null}
          <label>
            Search
            <input
              type="search"
              name="findingQuery"
              defaultValue={data.findingFilters.query}
              placeholder="SKU, issue, or action"
              maxLength={120}
            />
          </label>
          <label>
            Severity
            <select
              name="findingSeverity"
              defaultValue={data.findingFilters.severity}
            >
              <option value="ALL">All severities</option>
              {FINDING_SEVERITIES.map((item) => (
                <option key={item} value={item}>
                  {humanize(item)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Category
            <select
              name="findingCategory"
              defaultValue={data.findingFilters.category}
            >
              <option value="ALL">All categories</option>
              {FINDING_CATEGORIES.filter(
                (item) =>
                  data.entitlements.locationAudit ||
                  item !== "LOCATION_MISMATCH",
              ).map((item) => (
                <option key={item} value={item}>
                  {humanize(item)}
                </option>
              ))}
            </select>
          </label>
          <div className={styles.filterActions}>
            <button className={styles.secondaryButton} type="submit">
              Apply filters
            </button>
            <Link
              className={styles.textButton}
              to={viewHref("findings", selectedBatchId, data.runHistory.page)}
            >
              Clear
            </Link>
          </div>
        </Form>
        {!selectedBatchId ? (
          <EmptyState
            title="No run selected"
            detail="Choose a migration run to see its findings."
          />
        ) : data.findingTotal === 0 ? (
          <EmptyState
            title="No audit findings"
            detail={
              data.latestSnapshot?.status === "SUCCEEDED"
                ? "This run has no matching, metadata, supplier, purchase-order, or location issues against its linked Shopify snapshot. Download the migration record for handoff."
                : "No file-level findings were found. Sync Shopify from Files to generate catalog-matching findings."
            }
          />
        ) : data.findingResults.total > 0 ? (
          <div className={styles.findingList}>
            {data.findings.map((finding) => (
              <article className={styles.finding} key={finding.id}>
                <div className={styles.findingMeta}>
                  <StatusPill value={finding.severity} />
                  <span>{humanize(finding.category)}</span>
                  {finding.sku ? <code>{finding.sku}</code> : null}
                </div>
                <h4>{finding.title}</h4>
                <p>{finding.message}</p>
                <div className={styles.recommendation}>
                  <strong>Recommended action</strong>
                  <span>{finding.recommendedAction}</span>
                </div>
                <SourceContext source={finding.source} />
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No findings match"
            detail="Clear a filter or search term to see the full audit."
          />
        )}
        {data.findingResults.pageCount > 1 ? (
          <nav className={styles.historyPagination} aria-label="Finding pages">
            <span>
              Page {data.findingResults.page} of {data.findingResults.pageCount}
            </span>
            <div>
              {data.findingResults.page > 1 ? (
                <Link
                  className={styles.secondaryButton}
                  to={findingHref(
                    data,
                    selectedBatchId,
                    data.findingResults.page - 1,
                  )}
                >
                  Previous
                </Link>
              ) : null}
              {data.findingResults.page < data.findingResults.pageCount ? (
                <Link
                  className={styles.secondaryButton}
                  to={findingHref(
                    data,
                    selectedBatchId,
                    data.findingResults.page + 1,
                  )}
                >
                  Next
                </Link>
              ) : null}
            </div>
          </nav>
        ) : null}
      </section>
    </div>
  );
}

function Exports({ data, selectedBatchId }: ViewProps) {
  const migrationPackageAvailable = data.entitlements.reviewKit;

  return (
    <div className={styles.stack}>
      <section className={styles.panel}>
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>Migration handoff</p>
            <h3>Download the complete migration package</h3>
            <p>
              One ZIP with every preserved original CSV, all four generated
              reports, open purchase-order import files, and a SHA-256 checksum
              manifest.
            </p>
          </div>
          {selectedBatchId && migrationPackageAvailable ? (
            <AuthenticatedDownloadButton
              label="Download migration package"
              path={`/app/review-kit?batch=${encodeURIComponent(selectedBatchId)}`}
              primary
            />
          ) : selectedBatchId ? (
            <span className={styles.lockedLabel}>Unavailable</span>
          ) : null}
        </div>
        {!selectedBatchId ? (
          <EmptyState
            title="No run selected"
            detail="Choose a migration run before generating exports."
          />
        ) : null}
      </section>
      <section className={styles.panel}>
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>Open purchase orders</p>
            <h3>Move remaining Stocky order lines into Shopify drafts</h3>
            <p>
              Download one official-format Shopify import CSV per open Stocky
              PO. Closed work is excluded. Partial, duplicate, unidentified, and
              unsafe-quantity lines are withheld in a separate manual-review
              report.
            </p>
          </div>
          {selectedBatchId && migrationPackageAvailable ? (
            <AuthenticatedDownloadButton
              label="Download open PO files"
              path={`/app/open-po-imports?batch=${encodeURIComponent(selectedBatchId)}`}
            />
          ) : selectedBatchId ? (
            <span className={styles.lockedLabel}>Unavailable</span>
          ) : (
            <button disabled>Choose a run</button>
          )}
        </div>
        <p className={styles.muted}>
          These files recreate open work only. They do not import historical
          Stocky purchase orders as Shopify history. Verify supplier,
          destination, remaining quantity, cost, tax, and currency before
          marking any Shopify purchase order as ordered. Generic Stocky Tax
          columns are left blank unless the source explicitly identifies a tax
          rate or percentage.
        </p>
      </section>
      <section className={styles.exportGrid}>
        {data.exports.map((item) => (
          <article className={styles.exportCard} key={item.type}>
            <div>
              <h3>{item.label}</h3>
              <p>{item.description}</p>
            </div>
            {selectedBatchId && item.available ? (
              <AuthenticatedDownloadButton
                label="Download CSV"
                path={`/app/exports/${item.type}?batch=${encodeURIComponent(selectedBatchId)}`}
              />
            ) : selectedBatchId ? (
              <span className={styles.lockedLabel}>Unavailable</span>
            ) : (
              <button disabled>Choose a run</button>
            )}
          </article>
        ))}
      </section>
      <section className={styles.panel}>
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>History</p>
            <h3>Recent export activity</h3>
          </div>
        </div>
        {data.exportJobs.length ? (
          <div className={styles.tableWrap}>
            <table>
              <caption className={styles.srOnly}>
                Latest export activity for the selected migration run
              </caption>
              <thead>
                <tr>
                  <th scope="col">Report</th>
                  <th scope="col">Status</th>
                  <th scope="col">Completed</th>
                </tr>
              </thead>
              <tbody>
                {data.exportJobs.map((job) => (
                  <tr key={job.id}>
                    <td>{EXPORT_DETAILS[job.type].label}</td>
                    <td>
                      <StatusPill value={job.status} />
                    </td>
                    <td>
                      {job.completedAt
                        ? formatDate(job.completedAt)
                        : (job.errorMessage ?? "In progress")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title="No exports generated"
            detail="Downloads for the selected run will be recorded here."
          />
        )}
      </section>
    </div>
  );
}

function Settings({ data }: { data: LoaderData }) {
  const [confirmation, setConfirmation] = useState("");
  const [armed, setArmed] = useState(false);
  return (
    <div className={styles.stack}>
      <section className={styles.panel}>
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>Subscription</p>
            <h3>Manage your plan</h3>
          </div>
          <StatusPill value={data.billing.status} />
        </div>
        <p>
          {data.billing.active ? "Current" : "Most recent"} plan:{" "}
          <strong>
            {data.billing.activePlan ?? "Shopify App Pricing plan"}
          </strong>
          .
          {data.billing.active
            ? " Plan changes are completed securely through Shopify App Pricing."
            : " New uploads and catalog syncs are paused. Your existing source files, findings, and migration reports remain available so you can download or delete them."}
        </p>
        <Form method="post">
          <input type="hidden" name="intent" value="select_plan" />
          <button className={styles.secondaryButton} type="submit">
            View and change plan
          </button>
        </Form>
      </section>
      <section className={styles.panel}>
        <p className={styles.eyebrow}>Current allowances</p>
        <h3>{data.entitlements.label} migration capacity</h3>
        <dl className={styles.definitionList}>
          <div>
            <dt>Files per run</dt>
            <dd>{data.entitlements.maxFilesPerBatch}</dd>
          </div>
          <div>
            <dt>Largest file</dt>
            <dd>{formatBytes(data.entitlements.maxFileBytes)}</dd>
          </div>
          <div>
            <dt>Combined file size per run</dt>
            <dd>{formatBytes(data.entitlements.maxBatchBytes)}</dd>
          </div>
          <div>
            <dt>Rows per file</dt>
            <dd>{data.entitlements.maxRowsPerFile.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Parsed rows per run</dt>
            <dd>{data.entitlements.maxRowsPerBatch.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Stored source data</dt>
            <dd>
              {formatBytes(data.storage.usedBytes)} of{" "}
              {formatBytes(data.storage.maxBytes)}
            </dd>
          </div>
          <div>
            <dt>Stocky location-name check</dt>
            <dd>Included; names only, not per-SKU quantities</dd>
          </div>
          <div>
            <dt>All reports and migration package</dt>
            <dd>Included</dd>
          </div>
          <div>
            <dt>Verified Shopify catalog</dt>
            <dd>
              Up to {data.catalogVariantLimit.toLocaleString()} variants; larger
              catalogs fail without a partial audit
            </dd>
          </div>
        </dl>
        <div className={styles.planGrid} aria-label="Shopify App Pricing plans">
          {data.billingPlans.map((plan) => (
            <article key={plan.id}>
              <strong>
                {plan.name} · {plan.price}
              </strong>
              <span>{plan.summary}</span>
            </article>
          ))}
        </div>
      </section>
      <section className={styles.panel}>
        <p className={styles.eyebrow}>Data retention</p>
        <h3>What Stocky Escape Kit keeps</h3>
        <p>
          Raw CSV bytes, file checksums, parsed rows, catalog snapshots,
          findings, and export history stay with this store until you delete a
          run or reset all migration data. A canceled subscription blocks new
          uploads and catalog syncs but still lets you retrieve reports or
          delete stored evidence. Uninstalling the app triggers deletion of the
          store record and its migration data when Shopify delivers the
          uninstall webhook.
        </p>
        <p>
          The app uses read-only Shopify GraphQL access and never imports
          historical Stocky purchase orders into Shopify.
        </p>
      </section>
      <section className={styles.panel}>
        <p className={styles.eyebrow}>Support</p>
        <h3>Get help with a migration run</h3>
        <p>
          Keep the original CSV and note the run date and affected filename.
          Never send passwords, Shopify access tokens, or other credentials.
        </p>
        <a
          className={styles.secondaryButton}
          href="/support"
          target="_blank"
          rel="noreferrer"
          aria-label="Open support guide in a new tab"
        >
          Open support guide
        </a>
      </section>
      <section className={`${styles.panel} ${styles.dangerPanel}`}>
        <p className={styles.eyebrow}>Destructive control</p>
        <h3>Reset migration data</h3>
        <p>
          Deletes only this store’s uploads, raw archives, parsed rows, catalog
          snapshots, findings, and export jobs. This cannot be undone.
        </p>
        {armed ? (
          <Form method="post" className={styles.confirmForm}>
            <input type="hidden" name="intent" value="reset_store_data" />
            <label>
              Type <strong>{data.resetConfirmation}</strong>
              <input
                name="confirmation"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
              />
            </label>
            <div className={styles.actionRow}>
              <button
                className={styles.dangerButton}
                type="submit"
                disabled={confirmation !== data.resetConfirmation}
              >
                Permanently reset migration data
              </button>
              <button
                type="button"
                className={styles.textButton}
                onClick={() => {
                  setArmed(false);
                  setConfirmation("");
                }}
              >
                Cancel
              </button>
            </div>
          </Form>
        ) : (
          <button
            type="button"
            className={styles.dangerButton}
            onClick={() => setArmed(true)}
          >
            Begin reset
          </button>
        )}
      </section>
    </div>
  );
}

function RunPicker({
  batches,
  selectedBatch,
  selectedBatchId,
  runsPage,
  view,
}: {
  batches: LoaderData["batches"];
  selectedBatch: LoaderData["selectedBatch"];
  selectedBatchId: string | null;
  runsPage: number;
  view: View;
}) {
  const navigate = useNavigate();
  const options =
    selectedBatch && !batches.some((batch) => batch.id === selectedBatch.id)
      ? [selectedBatch, ...batches]
      : batches;
  return (
    <label className={styles.runPicker}>
      Migration run
      <select
        value={selectedBatchId ?? ""}
        onChange={(event) =>
          navigate(viewHref(view, event.target.value || null, runsPage))
        }
        disabled={!options.length}
      >
        {!options.length ? <option value="">No runs yet</option> : null}
        {options.map((batch) => (
          <option key={batch.id} value={batch.id}>
            {formatRunName(batch.createdAt)} · {batch.fileCount} files
          </option>
        ))}
      </select>
    </label>
  );
}

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: number;
  detail: string;
}) {
  return (
    <article className={styles.metric}>
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
      <small>{detail}</small>
    </article>
  );
}
function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className={styles.emptyState}>
      <strong>{title}</strong>
      <p>{detail}</p>
    </div>
  );
}
function StatusPill({ value }: { value: string }) {
  return (
    <span className={`${styles.pill} ${styles[`pill${value}`] ?? ""}`}>
      {STATUS_LABELS[value] ?? humanize(value)}
    </span>
  );
}
function StatusBanner({ data }: { data: ActionData }) {
  return (
    <div
      className={`${styles.banner} ${styles[`banner${data.status}`]}`}
      role={data.status === "error" ? "alert" : "status"}
    >
      <strong>
        {data.status === "success"
          ? "Complete"
          : data.status === "partial"
            ? "Completed with exceptions"
            : "Action needed"}
      </strong>
      <span>{data.message}</span>
    </div>
  );
}
function BillingBanner({ data }: { data: LoaderData }) {
  const planLink = (
    <Form method="post">
      <input type="hidden" name="intent" value="select_plan" />
      <button className={styles.secondaryButton} type="submit">
        {data.billing.active ? "Verify plan" : "Reactivate plan"}
      </button>
    </Form>
  );

  return (
    <section
      className={
        data.billing.active ? styles.billingNotice : styles.billingWarning
      }
      role={data.billing.active ? "status" : "alert"}
    >
      <div>
        <strong>
          {data.billing.active
            ? "Shopify billing could not be refreshed"
            : "Subscription ended — stored evidence is read-only"}
        </strong>
        <p>
          {data.billing.active
            ? "Existing paid access is using the last verified active status for a bounded 24-hour grace period while the Partner API is unavailable."
            : "You can review findings, download original CSV files and migration reports, delete one run, or permanently reset all data. Reactivate to upload or sync again."}
        </p>
      </div>
      {planLink}
    </section>
  );
}
function SourceContext({ source }: { source: unknown }) {
  if (!source || typeof source !== "object" || Array.isArray(source))
    return null;
  const value = source as Record<string, unknown>;
  const filename = typeof value.filename === "string" ? value.filename : null;
  const row =
    typeof value.sourceRowNumber === "number" ? value.sourceRowNumber : null;
  const rows = Array.isArray(value.sourceRowNumbers)
    ? value.sourceRowNumbers.filter(
        (item): item is number => typeof item === "number",
      )
    : [];
  const affectedRowCount =
    typeof value.affectedRowCount === "number"
      ? value.affectedRowCount
      : rows.length;
  if (!filename && !row && rows.length === 0) return null;
  return (
    <p className={styles.source}>
      Source: {filename ?? "Stocky export"}
      {row ? ` · row ${row}` : ""}
      {rows.length > 0
        ? ` · rows ${rows.slice(0, 8).join(", ")}${affectedRowCount > 8 ? ` (+${affectedRowCount - 8} more)` : ""}`
        : ""}
    </p>
  );
}

function AuthenticatedDownloadButton({
  label,
  path,
  primary = false,
}: {
  label: string;
  path: string;
  primary?: boolean;
}) {
  const shopify = useAppBridge();
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function download() {
    setIsDownloading(true);
    setError(null);
    try {
      const response = await fetch(path, {
        headers: { Authorization: `Bearer ${await shopify.idToken()}` },
      });
      if (!response.ok)
        throw new Error(`Download failed with status ${response.status}.`);
      const blob = await response.blob();
      const filename =
        response.headers
          .get("Content-Disposition")
          ?.match(/filename="([^"]+)"/)?.[1] ?? "stocky-export";
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (downloadError) {
      setError(
        downloadError instanceof Error
          ? downloadError.message
          : "Download failed.",
      );
    } finally {
      setIsDownloading(false);
    }
  }
  return (
    <span className={styles.downloadControl}>
      <button
        type="button"
        className={primary ? styles.primaryButton : styles.secondaryButton}
        onClick={download}
        disabled={isDownloading}
      >
        {isDownloading ? "Preparing…" : label}
      </button>
      {error ? (
        <span className={styles.errorText} role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}

function serializeBatch(
  batch: Awaited<ReturnType<typeof getOwnedUploadBatch>> extends infer T
    ? NonNullable<T>
    : never,
) {
  return {
    id: batch.id,
    status: batch.status,
    fileCount: batch.fileCount,
    importedRowCount: batch.importedRowCount,
    warningCount: batch.warningCount,
    auditedAt: batch.auditedAt?.toISOString() ?? null,
    auditSnapshotId: batch.auditSnapshotId,
    createdAt: batch.createdAt.toISOString(),
    files: batch.uploadedFiles.map((file) => ({
      id: file.id,
      filename: file.originalFilename,
      reportType: file.detectedReportType,
      status: file.parseStatus,
      rowCount: file.rowCount,
      warningCount: file.warningCount,
      errorMessage: file.errorMessage,
      rawCsvDownloadHref: file.storagePointer.startsWith(
        "db:uploaded_file.rawContentBase64",
      )
        ? `/app/uploads/${file.id}/raw`
        : null,
      rawContentByteLength: file.rawContentByteLength,
    })),
  };
}

type LoaderData = Awaited<ReturnType<typeof loader>>;
type SerializedBatch = NonNullable<LoaderData["selectedBatch"]>;
type ViewProps = {
  data: LoaderData;
  selectedBatchId: string | null;
  onViewChange: (view: View) => void;
};

function viewHref(
  view: View,
  batchId: string | null,
  runsPage = 1,
  extraParams?: Record<string, string>,
) {
  const params = new URLSearchParams();
  if (batchId) params.set("batch", batchId);
  if (runsPage > 1) params.set("runsPage", String(runsPage));
  for (const [key, value] of Object.entries(extraParams ?? {})) {
    params.set(key, value);
  }
  const query = params.size ? `?${params}` : "";
  return `/app/${view}${query}`;
}
function findingHref(data: LoaderData, batchId: string | null, page: number) {
  const params = new URLSearchParams();
  if (batchId) params.set("batch", batchId);
  if (data.runHistory.page > 1) {
    params.set("runsPage", String(data.runHistory.page));
  }
  if (data.findingFilters.query) {
    params.set("findingQuery", data.findingFilters.query);
  }
  if (data.findingFilters.severity !== "ALL") {
    params.set("findingSeverity", data.findingFilters.severity);
  }
  if (data.findingFilters.category !== "ALL") {
    params.set("findingCategory", data.findingFilters.category);
  }
  if (page > 1) params.set("findingsPage", String(page));
  const query = params.size ? `?${params}` : "";
  return `/app/findings${query}`;
}
function viewLabel(view: View) {
  return view.charAt(0).toUpperCase() + view.slice(1);
}
function humanize(value: string) {
  return value
    .toLowerCase()
    .split("_")
    .map((part) =>
      DISPLAY_ACRONYMS.has(part)
        ? part.toUpperCase()
        : part.charAt(0).toUpperCase() + part.slice(1),
    )
    .join(" ");
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
function formatRunName(value: string) {
  return `Run · ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value))}`;
}
function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }

  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
function fileKey(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function reportTypeLabel(value: string) {
  if (value === "VENDORS") {
    return "Custom supplier evidence";
  }

  if (value === "UNKNOWN") {
    return "Unclassified evidence";
  }

  return humanize(value);
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
