import { ExportType, SyncStatus } from "@prisma/client";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { regenerateAuditFindings } from "../lib/audit.server";
import { syncShopifyCatalog } from "../lib/catalog.server";
import { importStockyCsvFiles } from "../lib/uploads.server";
import {
  BILLING_PLAN_DETAILS,
  BILLING_PLAN_NAMES,
  getActiveBillingName,
  isBillingTestMode,
  isValidBillingPlan,
  updateStoreBillingStatus,
} from "../models/billing.server";
import { upsertInstalledStore } from "../models/store.server";

type ActionData = {
  status: "success" | "error";
  message: string;
};

const EXPORT_LABELS: Record<ExportType, string> = {
  ARCHIVE_CSV: "Archive CSV",
  SKU_GAP_REPORT: "SKU gap report",
  SUPPLIER_RECONSTRUCTION_REPORT: "Supplier reconstruction",
  MIGRATION_CHECKLIST: "Migration checklist",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { billing, session } = await authenticate.admin(request);
  const store = await upsertInstalledStore({
    shop: session.shop,
    scopes: session.scope ?? null,
  });
  const billingCheck = await billing.check({
    plans: BILLING_PLAN_NAMES,
    isTest: isBillingTestMode(),
  });

  const billingStatus = await updateStoreBillingStatus({
    shop: session.shop,
    billingCheck,
  });

  const [latestBatch, latestSnapshot, exportJobs] = await Promise.all([
    db.uploadBatch.findFirst({
      where: { storeId: store.id },
      orderBy: { createdAt: "desc" },
      include: {
        uploadedFiles: {
          orderBy: { createdAt: "asc" },
        },
      },
    }),
    db.shopifyCatalogSnapshot.findFirst({
      where: { storeId: store.id },
      orderBy: { createdAt: "desc" },
    }),
    db.exportJob.findMany({
      where: { storeId: store.id },
      orderBy: { createdAt: "desc" },
      take: 4,
    }),
  ]);

  const where = latestBatch
    ? { storeId: store.id, batchId: latestBatch.id }
    : { storeId: store.id };

  const [findingGroups, recentFindings] = await Promise.all([
    db.auditFinding.groupBy({
      by: ["severity", "category"],
      where,
      _count: { _all: true },
    }),
    db.auditFinding.findMany({
      where,
      orderBy: [{ severity: "asc" }, { createdAt: "desc" }],
      take: 12,
    }),
  ]);

  const severityCounts = {
    CRITICAL: 0,
    WARNING: 0,
    INFO: 0,
  };

  for (const group of findingGroups) {
    severityCounts[group.severity] += group._count._all;
  }

  return {
    shop: session.shop,
    scopes: session.scope ?? "read_products,read_inventory,read_locations",
    billing: {
      active: billingCheck.hasActivePayment,
      status: billingStatus,
      activePlan: getActiveBillingName(billingCheck),
      testMode: isBillingTestMode(),
    },
    billingPlans: BILLING_PLAN_DETAILS,
    latestBatch: latestBatch
      ? {
          id: latestBatch.id,
          status: latestBatch.status,
          fileCount: latestBatch.fileCount,
          importedRowCount: latestBatch.importedRowCount,
          warningCount: latestBatch.warningCount,
          createdAt: latestBatch.createdAt.toISOString(),
          files: latestBatch.uploadedFiles.map((file) => ({
            id: file.id,
            filename: file.originalFilename,
            reportType: file.detectedReportType,
            status: file.parseStatus,
            rowCount: file.rowCount,
            warningCount: file.warningCount,
            errorMessage: file.errorMessage,
          })),
        }
      : null,
    latestSnapshot: latestSnapshot
      ? {
          status: latestSnapshot.syncStatus,
          productCount: latestSnapshot.productCount,
          variantCount: latestSnapshot.variantCount,
          inventoryItemCount: latestSnapshot.inventoryItemCount,
          inventoryLevelCount: latestSnapshot.inventoryLevelCount,
          locationCount: latestSnapshot.locationCount,
          errorMessage: latestSnapshot.errorMessage,
          syncedAt: latestSnapshot.syncedAt?.toISOString() ?? null,
        }
      : null,
    findingGroups: findingGroups.map((group) => ({
      severity: group.severity,
      category: group.category,
      count: group._count._all,
    })),
    severityCounts,
    recentFindings: recentFindings.map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      category: finding.category,
      sku: finding.sku,
      title: finding.title,
      message: finding.message,
      recommendedAction: finding.recommendedAction,
    })),
    exports: Object.values(ExportType).map((type) => ({
      type,
      label: EXPORT_LABELS[type],
      href: `/app/exports/${type}`,
    })),
    exportJobs: exportJobs.map((job) => ({
      id: job.id,
      type: job.exportType,
      status: job.status,
      completedAt: job.completedAt?.toISOString() ?? null,
      errorMessage: job.errorMessage,
    })),
  };
};

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ActionData | null> => {
  const { admin, billing, session } = await authenticate.admin(request);
  const store = await upsertInstalledStore({
    shop: session.shop,
    scopes: session.scope ?? null,
  });
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "select_plan") {
    const plan = formData.get("plan");

    if (!isValidBillingPlan(plan)) {
      return {
        status: "error",
        message: "Unknown billing plan.",
      };
    }

    await billing.request({
      plan,
      isTest: isBillingTestMode(),
      returnUrl: new URL("/app", request.url).toString(),
    });

    return null;
  }

  const billingCheck = await billing.check({
    plans: BILLING_PLAN_NAMES,
    isTest: isBillingTestMode(),
  });

  await updateStoreBillingStatus({
    shop: session.shop,
    billingCheck,
  });

  if (!billingCheck.hasActivePayment) {
    return {
      status: "error",
      message:
        "Choose a Shopify billing plan before uploading CSVs, syncing Shopify, or exporting reports.",
    };
  }

  if (intent === "upload_csv") {
    const files = formData
      .getAll("csvFiles")
      .filter(
        (entry): entry is File => entry instanceof File && entry.size > 0,
      );

    if (files.length === 0) {
      return {
        status: "error",
        message: "Upload at least one Stocky CSV file.",
      };
    }

    const result = await importStockyCsvFiles({
      storeId: store.id,
      files,
    });

    return {
      status: result.importedRowCount > 0 ? "success" : "error",
      message: `Processed ${result.fileCount} file(s), imported ${result.importedRowCount} row(s), recorded ${result.warningCount} warning(s), and rejected ${result.failedFileCount} file(s).`,
    };
  }

  if (intent === "sync_catalog") {
    const snapshot = await syncShopifyCatalog({
      admin,
      storeId: store.id,
    });

    const latestBatch = await db.uploadBatch.findFirst({
      where: { storeId: store.id },
      orderBy: { createdAt: "desc" },
    });

    if (latestBatch && snapshot.syncStatus === SyncStatus.SUCCEEDED) {
      await regenerateAuditFindings({
        storeId: store.id,
        batchId: latestBatch.id,
      });
    }

    if (snapshot.syncStatus === SyncStatus.FAILED) {
      return {
        status: "error",
        message:
          snapshot.errorMessage ??
          "Shopify catalog sync failed without details.",
      };
    }

    return {
      status: "success",
      message: `Synced ${snapshot.variantCount} variants across ${snapshot.locationCount} location(s).`,
    };
  }

  return {
    status: "error",
    message: "Unknown action.",
  };
};

export default function Index() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <s-page heading="Stocky Escape Kit">
      {actionData ? (
        <s-section
          heading={actionData.status === "success" ? "Done" : "Action needed"}
        >
          <s-paragraph>{actionData.message}</s-paragraph>
        </s-section>
      ) : null}

      <s-section heading="1. Shopify link and billing">
        <s-paragraph>
          <s-text>Shop: </s-text>
          <s-text>{data.shop}</s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text>Scopes: </s-text>
          <s-text>{data.scopes}</s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text>Billing: </s-text>
          <s-text>
            {data.billing.active
              ? `${data.billing.activePlan ?? data.billing.status}${data.billing.testMode ? " (test)" : ""}`
              : `not active${data.billing.testMode ? " (test mode available)" : ""}`}
          </s-text>
        </s-paragraph>

        {!data.billing.active ? (
          <div style={gridStyle}>
            {data.billingPlans.map((plan) => (
              <Form method="post" key={plan.id} style={panelStyle}>
                <input type="hidden" name="intent" value="select_plan" />
                <input type="hidden" name="plan" value={plan.name} />
                <h3 style={headingStyle}>{plan.name}</h3>
                <p style={priceStyle}>{plan.price}</p>
                <p>{plan.summary}</p>
                <s-button type="submit">Choose plan</s-button>
              </Form>
            ))}
          </div>
        ) : null}
      </s-section>

      <s-section heading="2. Upload Stocky CSV exports">
        {data.billing.active ? (
          <Form method="post" encType="multipart/form-data">
            <input type="hidden" name="intent" value="upload_csv" />
            <div style={fieldStyle}>
              <label htmlFor="csvFiles">Stocky CSV files</label>
              <input
                id="csvFiles"
                name="csvFiles"
                type="file"
                accept=".csv,text/csv"
                multiple
              />
            </div>
            <s-button type="submit">Upload and parse</s-button>
          </Form>
        ) : (
          <s-paragraph>
            Billing must be active before uploads are accepted.
          </s-paragraph>
        )}

        {data.latestBatch ? (
          <div style={tableWrapStyle}>
            <table style={tableStyle}>
              <caption>Latest upload batch</caption>
              <tbody>
                <tr>
                  <th scope="row">Status</th>
                  <td>{data.latestBatch.status}</td>
                </tr>
                <tr>
                  <th scope="row">Files</th>
                  <td>{data.latestBatch.fileCount}</td>
                </tr>
                <tr>
                  <th scope="row">Imported rows</th>
                  <td>{data.latestBatch.importedRowCount}</td>
                </tr>
                <tr>
                  <th scope="row">Warnings</th>
                  <td>{data.latestBatch.warningCount}</td>
                </tr>
              </tbody>
            </table>

            <table style={tableStyle}>
              <caption>Parsed files</caption>
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col">Detected type</th>
                  <th scope="col">Status</th>
                  <th scope="col">Rows</th>
                  <th scope="col">Warnings</th>
                  <th scope="col">Details</th>
                </tr>
              </thead>
              <tbody>
                {data.latestBatch.files.map((file) => (
                  <tr key={file.id}>
                    <td>{file.filename}</td>
                    <td>{file.reportType}</td>
                    <td>{file.status}</td>
                    <td>{file.rowCount}</td>
                    <td>{file.warningCount}</td>
                    <td>{file.errorMessage ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </s-section>

      <s-section heading="3. Sync Shopify catalog">
        {data.billing.active ? (
          <Form method="post">
            <input type="hidden" name="intent" value="sync_catalog" />
            <s-button type="submit">Sync products and inventory</s-button>
          </Form>
        ) : (
          <s-paragraph>
            Billing must be active before Shopify catalog sync.
          </s-paragraph>
        )}

        {data.latestSnapshot ? (
          <table style={tableStyle}>
            <caption>Latest Shopify catalog sync</caption>
            <tbody>
              <tr>
                <th scope="row">Status</th>
                <td>{data.latestSnapshot.status}</td>
              </tr>
              <tr>
                <th scope="row">Products</th>
                <td>{data.latestSnapshot.productCount}</td>
              </tr>
              <tr>
                <th scope="row">Variants</th>
                <td>{data.latestSnapshot.variantCount}</td>
              </tr>
              <tr>
                <th scope="row">Inventory items</th>
                <td>{data.latestSnapshot.inventoryItemCount}</td>
              </tr>
              <tr>
                <th scope="row">Inventory levels</th>
                <td>{data.latestSnapshot.inventoryLevelCount}</td>
              </tr>
              <tr>
                <th scope="row">Locations</th>
                <td>{data.latestSnapshot.locationCount}</td>
              </tr>
              {data.latestSnapshot.errorMessage ? (
                <tr>
                  <th scope="row">Message</th>
                  <td>{data.latestSnapshot.errorMessage}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        ) : null}
      </s-section>

      <s-section heading="4. Audit findings">
        <div style={gridStyle}>
          <MetricCard label="Critical" value={data.severityCounts.CRITICAL} />
          <MetricCard label="Warnings" value={data.severityCounts.WARNING} />
          <MetricCard label="Info" value={data.severityCounts.INFO} />
        </div>

        {data.findingGroups.length > 0 ? (
          <table style={tableStyle}>
            <caption>Finding categories</caption>
            <thead>
              <tr>
                <th scope="col">Severity</th>
                <th scope="col">Category</th>
                <th scope="col">Count</th>
              </tr>
            </thead>
            <tbody>
              {data.findingGroups.map((group) => (
                <tr key={`${group.severity}-${group.category}`}>
                  <td>{group.severity}</td>
                  <td>{group.category}</td>
                  <td>{group.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <s-paragraph>No audit findings yet.</s-paragraph>
        )}

        {data.recentFindings.length > 0 ? (
          <table style={tableStyle}>
            <caption>Recent findings</caption>
            <thead>
              <tr>
                <th scope="col">Severity</th>
                <th scope="col">SKU</th>
                <th scope="col">Finding</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {data.recentFindings.map((finding) => (
                <tr key={finding.id}>
                  <td>{finding.severity}</td>
                  <td>{finding.sku ?? ""}</td>
                  <td>
                    <strong>{finding.title}</strong>
                    <br />
                    {finding.message}
                  </td>
                  <td>{finding.recommendedAction}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </s-section>

      <s-section heading="5. Report exports">
        {data.billing.active ? (
          <ul style={exportListStyle}>
            {data.exports.map((item) => (
              <li key={item.type}>
                <a href={item.href}>{item.label}</a>
              </li>
            ))}
          </ul>
        ) : (
          <s-paragraph>
            Billing must be active before exports are available.
          </s-paragraph>
        )}

        {data.exportJobs.length > 0 ? (
          <table style={tableStyle}>
            <caption>Recent export jobs</caption>
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">Status</th>
                <th scope="col">Completed</th>
              </tr>
            </thead>
            <tbody>
              {data.exportJobs.map((job) => (
                <tr key={job.id}>
                  <td>{EXPORT_LABELS[job.type]}</td>
                  <td>{job.status}</td>
                  <td>{job.completedAt ?? job.errorMessage ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </s-section>

      <s-section slot="aside" heading="V1 boundaries">
        <s-paragraph>
          This app preserves parsed Stocky rows and metadata, audits migration
          gaps, and produces reports. It does not import historical Stocky
          purchase orders into Shopify.
        </s-paragraph>
        <s-paragraph>
          Shopify access is read-only and uses the Admin GraphQL API.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

function MetricCard({ label, value }: { label: string; value: number }) {
  return (
    <div style={panelStyle}>
      <p style={metricValueStyle}>{value}</p>
      <p>{label}</p>
    </div>
  );
}

const gridStyle = {
  display: "grid",
  gap: "12px",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
} as const;

const panelStyle = {
  border: "1px solid #d9d9d9",
  borderRadius: "8px",
  padding: "12px",
} as const;

const headingStyle = {
  margin: "0 0 8px",
} as const;

const priceStyle = {
  fontSize: "1.5rem",
  fontWeight: 700,
  margin: "0 0 8px",
} as const;

const fieldStyle = {
  display: "grid",
  gap: "6px",
  marginBottom: "12px",
} as const;

const tableWrapStyle = {
  display: "grid",
  gap: "16px",
  marginTop: "16px",
} as const;

const tableStyle = {
  borderCollapse: "collapse",
  marginTop: "16px",
  width: "100%",
} as const;

const metricValueStyle = {
  fontSize: "1.75rem",
  fontWeight: 700,
  margin: 0,
} as const;

const exportListStyle = {
  display: "grid",
  gap: "8px",
  paddingLeft: "20px",
} as const;

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
