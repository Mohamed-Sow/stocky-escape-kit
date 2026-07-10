import {
  ExportType,
  FindingCategory,
  FindingSeverity,
  SyncStatus,
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
  useActionData,
  useFetcher,
  useLoaderData,
  useLocation,
  useNavigate,
  useNavigation,
  useParams,
} from "react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import db from "../db.server";
import { regenerateAuditFindings } from "../lib/audit.server";
import {
  getOwnedUploadBatch,
  requireOwnedUploadBatch,
} from "../lib/batches.server";
import { syncShopifyCatalog } from "../lib/catalog.server";
import {
  RESET_CONFIRMATION,
  resetStoreMigrationData,
} from "../lib/reset.server";
import { importStockyCsvFiles } from "../lib/uploads.server";
import {
  BILLING_PLAN_DETAILS,
  getActiveBillingName,
  getPartnerBillingCheckForAdmin,
  getPlanSelectionUrl,
  hasActiveBillingSubscription,
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
    label: "SKU gap report",
    description:
      "Critical matching gaps and Shopify product-data issues for this run.",
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
  const billingActive = hasActiveBillingSubscription(billingCheck);

  if (!billingActive) {
    throw redirect(getPlanSelectionUrl(session.shop), { target: "_top" });
  }

  const url = new URL(request.url);
  const requestedBatchId = url.searchParams.get("batch");
  const [batches, latestSnapshot] = await Promise.all([
    db.uploadBatch.findMany({
      where: { storeId: store.id },
      orderBy: { createdAt: "desc" },
      take: 25,
      include: { uploadedFiles: { orderBy: { createdAt: "asc" } } },
    }),
    db.shopifyCatalogSnapshot.findFirst({
      where: { storeId: store.id },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  const selectedBatch = requestedBatchId
    ? await requireOwnedUploadBatch({
        storeId: store.id,
        batchId: requestedBatchId,
      })
    : (batches[0] ?? null);
  const findingWhere = selectedBatch
    ? { storeId: store.id, batchId: selectedBatch.id }
    : { storeId: store.id, batchId: "__no_batch__" };
  const [findingGroups, findings, exportJobs] = await Promise.all([
    db.auditFinding.groupBy({
      by: ["severity", "category"],
      where: findingWhere,
      _count: { _all: true },
    }),
    db.auditFinding.findMany({
      where: findingWhere,
      orderBy: [{ severity: "asc" }, { createdAt: "desc" }],
    }),
    db.exportJob.findMany({
      where: selectedBatch
        ? { storeId: store.id, batchId: selectedBatch.id }
        : { storeId: store.id, batchId: "__no_batch__" },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);
  const severityCounts = { CRITICAL: 0, WARNING: 0, INFO: 0 };

  for (const group of findingGroups) {
    severityCounts[group.severity] += group._count._all;
  }

  return {
    shop: session.shop,
    scopes: session.scope ?? "read_products,read_inventory,read_locations",
    billing: {
      active: billingActive,
      status: billingStatus,
      activePlan: getActiveBillingName(billingCheck),
    },
    billingPlans: BILLING_PLAN_DETAILS,
    batches: batches.map(serializeBatch),
    selectedBatch: selectedBatch ? serializeBatch(selectedBatch) : null,
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
    severityCounts,
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
    exports: Object.values(ExportType).map((type) => ({
      type,
      ...EXPORT_DETAILS[type],
    })),
    exportJobs: exportJobs.map((job) => ({
      id: job.id,
      type: job.exportType,
      status: job.status,
      completedAt: job.completedAt?.toISOString() ?? null,
      errorMessage: job.errorMessage,
    })),
    resetConfirmation: RESET_CONFIRMATION,
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
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "select_plan") {
    return redirect(getPlanSelectionUrl(session.shop), { target: "_top" });
  }

  const billingCheck = await getPartnerBillingCheckForAdmin({
    admin,
    shop: session.shop,
  });
  await updateStoreBillingStatus({ shop: session.shop, billingCheck });

  if (!hasActiveBillingSubscription(billingCheck)) {
    return {
      status: "error",
      message: "Choose an active Shopify App Pricing subscription first.",
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
        message: "Stage at least one Stocky CSV file.",
      };
    }

    const result = await importStockyCsvFiles({ storeId: store.id, files });
    return {
      status:
        result.failedFileCount === 0
          ? "success"
          : result.importedRowCount > 0
            ? "partial"
            : "error",
      batchId: result.batchId,
      message: `Processed ${result.fileCount} files as one run: ${result.importedRowCount} rows imported, ${result.warningCount} warnings, ${result.failedFileCount} failed file${result.failedFileCount === 1 ? "" : "s"}.`,
    };
  }

  if (intent === "sync_catalog") {
    const batchId = String(formData.get("batchId") ?? "");
    const batch = await requireOwnedUploadBatch({ storeId: store.id, batchId });
    const snapshot = await syncShopifyCatalog({ admin, storeId: store.id });

    if (snapshot.syncStatus === SyncStatus.FAILED) {
      return {
        status: "error",
        message: snapshot.errorMessage ?? "Shopify catalog sync failed.",
      };
    }

    const audit = await regenerateAuditFindings({
      storeId: store.id,
      batchId: batch.id,
    });
    return {
      status: "success",
      batchId: batch.id,
      message: `Synced ${snapshot.variantCount} variants across ${snapshot.locationCount} locations and generated ${audit.created} findings for this run.`,
    };
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
      return {
        status: "error",
        message: error instanceof Error ? error.message : "Reset failed.",
      };
    }
  }

  return { status: "error", message: "Unknown action." };
};

export default function Index() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const location = useLocation();
  const params = useParams();
  const url = new URLSearchParams(location.search);
  const requestedView = params.view ?? url.get("view");
  const [view, setView] = useState<View>(() =>
    VIEWS.includes(requestedView as View)
      ? (requestedView as View)
      : "overview",
  );
  const selectedBatchId = data.selectedBatch?.id ?? null;
  const shared = { data, selectedBatchId, onViewChange: setView };

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
          <RunPicker
            batches={data.batches}
            selectedBatchId={selectedBatchId}
            view={view}
          />
        </header>

        <nav className={styles.tabs} aria-label="Migration workspace">
          {VIEWS.map((item) => (
            <button
              type="button"
              key={item}
              className={item === view ? styles.activeTab : styles.tab}
              onClick={() => setView(item)}
              aria-current={item === view ? "page" : undefined}
            >
              {viewLabel(item)}
            </button>
          ))}
        </nav>

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

function Overview({ data, onViewChange }: ViewProps) {
  const batch = data.selectedBatch;
  const totalFindings = Object.values(data.severityCounts).reduce(
    (sum, count) => sum + count,
    0,
  );
  const nextAction = !batch
    ? {
        title: "Upload your Stocky exports",
        detail: "Stage all related files and submit them as one migration run.",
        view: "files" as const,
      }
    : !data.latestSnapshot || data.findings.length === 0
      ? {
          title: "Sync the Shopify catalog",
          detail:
            "Compare this run with current products, variants, inventory, and locations.",
          view: "files" as const,
        }
      : {
          title: "Review critical findings",
          detail:
            "Resolve identity and matching gaps before relying on the export kit.",
          view: "findings" as const,
        };

  return (
    <div className={styles.stack}>
      <section className={styles.nextAction}>
        <div>
          <p className={styles.eyebrow}>Critical next action</p>
          <h3>{nextAction.title}</h3>
          <p>{nextAction.detail}</p>
        </div>
        <button
          type="button"
          className={styles.primaryButton}
          onClick={() => onViewChange(nextAction.view)}
        >
          Continue
        </button>
      </section>
      <section className={styles.metricGrid} aria-label="Migration progress">
        <Metric
          label="Files preserved"
          value={batch?.fileCount ?? 0}
          detail={batch ? formatDate(batch.createdAt) : "No run yet"}
        />
        <Metric
          label="Rows imported"
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
                <dt>Imported rows</dt>
                <dd>{batch.importedRowCount}</dd>
              </div>
              <div>
                <dt>Warnings</dt>
                <dd>{batch.warningCount}</dd>
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
            </dl>
          ) : (
            <EmptyState
              title="No catalog snapshot"
              detail="Sync from Files after choosing a migration run."
            />
          )}
        </section>
      </div>
    </div>
  );
}

function Files({ data, selectedBatchId }: ViewProps) {
  const navigate = useNavigate();
  return (
    <div className={styles.stack}>
      <FileStager key={selectedBatchId ?? "new-run"} />
      <section className={styles.panel}>
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>Selected run</p>
            <h3>Preserved source files</h3>
          </div>
          {data.selectedBatch ? (
            <CatalogSync batchId={data.selectedBatch.id} />
          ) : null}
        </div>
        {data.selectedBatch ? (
          <FilesTable files={data.selectedBatch.files} />
        ) : (
          <EmptyState
            title="No run selected"
            detail="Stage related Stocky CSV exports above and upload them together."
          />
        )}
      </section>
      <section className={styles.panel}>
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>History</p>
            <h3>Migration runs</h3>
          </div>
        </div>
        {data.batches.length ? (
          <div className={styles.historyList}>
            {data.batches.map((batch) => (
              <button
                type="button"
                key={batch.id}
                onClick={() => navigate(viewHref("files", batch.id))}
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
      </section>
    </div>
  );
}

function FileStager() {
  const fetcher = useFetcher<ActionData>();
  const navigate = useNavigate();
  const [files, setFiles] = useState<File[]>([]);
  const [duplicateMessage, setDuplicateMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
    setFiles((current) => [...current, ...additions]);
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
                onClick={() =>
                  setFiles((current) =>
                    current.filter((item) => fileKey(item) !== fileKey(file)),
                  )
                }
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
          disabled={!files.length || fetcher.state !== "idle"}
          onClick={submit}
        >
          {fetcher.state === "idle"
            ? `Upload ${files.length || ""} file${files.length === 1 ? "" : "s"}`
            : "Uploading and parsing…"}
        </button>
        <span className={styles.muted}>
          One submission creates one traceable UploadBatch.
        </span>
      </div>
      {fetcher.data ? <StatusBanner data={fetcher.data} /> : null}
    </section>
  );
}

function CatalogSync({ batchId }: { batchId: string }) {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  return (
    <Form method="post">
      <input type="hidden" name="intent" value="sync_catalog" />
      <input type="hidden" name="batchId" value={batchId} />
      <button className={styles.secondaryButton} type="submit" disabled={busy}>
        {busy ? "Syncing…" : "Sync Shopify and audit"}
      </button>
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
            <th scope="col">Warnings</th>
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
              <td>{humanize(file.reportType)}</td>
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
  const [severity, setSeverity] = useState("ALL");
  const [category, setCategory] = useState("ALL");
  const [query, setQuery] = useState("");
  const filtered = useMemo(
    () =>
      data.findings.filter((finding) => {
        const matchesSeverity =
          severity === "ALL" || finding.severity === severity;
        const matchesCategory =
          category === "ALL" || finding.category === category;
        const haystack =
          `${finding.sku ?? ""} ${finding.title} ${finding.message} ${finding.recommendedAction}`.toLowerCase();
        return (
          matchesSeverity &&
          matchesCategory &&
          haystack.includes(query.trim().toLowerCase())
        );
      }),
    [category, data.findings, query, severity],
  );

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
            {filtered.length} of {data.findings.length}
          </span>
        </div>
        <div className={styles.filters}>
          <label>
            Search
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="SKU, issue, or action"
            />
          </label>
          <label>
            Severity
            <select
              value={severity}
              onChange={(event) => setSeverity(event.target.value)}
            >
              <option value="ALL">All severities</option>
              {Object.values(FindingSeverity).map((item) => (
                <option key={item} value={item}>
                  {humanize(item)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Category
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            >
              <option value="ALL">All categories</option>
              {Object.values(FindingCategory).map((item) => (
                <option key={item} value={item}>
                  {humanize(item)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {!selectedBatchId ? (
          <EmptyState
            title="No run selected"
            detail="Choose a migration run to see its findings."
          />
        ) : filtered.length ? (
          <div className={styles.findingList}>
            {filtered.map((finding) => (
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
      </section>
    </div>
  );
}

function Exports({ data, selectedBatchId }: ViewProps) {
  return (
    <div className={styles.stack}>
      <section className={styles.panel}>
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>Review handoff</p>
            <h3>Download the complete review kit</h3>
            <p>
              One ZIP with all four CSV reports plus a SHA-256 checksum
              manifest.
            </p>
          </div>
          {selectedBatchId ? (
            <AuthenticatedDownloadButton
              label="Download review kit"
              path={`/app/review-kit?batch=${encodeURIComponent(selectedBatchId)}`}
              primary
            />
          ) : null}
        </div>
        {!selectedBatchId ? (
          <EmptyState
            title="No run selected"
            detail="Choose a migration run before generating exports."
          />
        ) : null}
      </section>
      <section className={styles.exportGrid}>
        {data.exports.map((item) => (
          <article className={styles.exportCard} key={item.type}>
            <div>
              <h3>{item.label}</h3>
              <p>{item.description}</p>
            </div>
            {selectedBatchId ? (
              <AuthenticatedDownloadButton
                label="Download CSV"
                path={`/app/exports/${item.type}?batch=${encodeURIComponent(selectedBatchId)}`}
              />
            ) : (
              <button disabled>Download CSV</button>
            )}
          </article>
        ))}
      </section>
      <section className={styles.panel}>
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.eyebrow}>History</p>
            <h3>Exports for this run</h3>
          </div>
        </div>
        {data.exportJobs.length ? (
          <div className={styles.tableWrap}>
            <table>
              <caption className={styles.srOnly}>
                Export history for the selected migration run
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
        <p className={styles.eyebrow}>Data retention</p>
        <h3>What Stocky Escape Kit keeps</h3>
        <p>
          Raw CSV bytes, file checksums, parsed rows, catalog snapshots,
          findings, and export history stay with this store until you reset
          them. Installation, billing, scopes, and Shopify sessions are
          operational records and are not part of this reset.
        </p>
        <p>
          The app uses read-only Shopify GraphQL access and never imports
          historical Stocky purchase orders into Shopify.
        </p>
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
  selectedBatchId,
  view,
}: {
  batches: LoaderData["batches"];
  selectedBatchId: string | null;
  view: View;
}) {
  const navigate = useNavigate();
  return (
    <label className={styles.runPicker}>
      Migration run
      <select
        value={selectedBatchId ?? ""}
        onChange={(event) =>
          navigate(viewHref(view, event.target.value || null))
        }
        disabled={!batches.length}
      >
        <option value="">No runs yet</option>
        {batches.map((batch) => (
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
      {humanize(value)}
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
function SourceContext({ source }: { source: unknown }) {
  if (!source || typeof source !== "object" || Array.isArray(source))
    return null;
  const value = source as Record<string, unknown>;
  const filename = typeof value.filename === "string" ? value.filename : null;
  const row =
    typeof value.sourceRowNumber === "number" ? value.sourceRowNumber : null;
  if (!filename && !row) return null;
  return (
    <p className={styles.source}>
      Source: {filename ?? "Stocky export"}
      {row ? ` · row ${row}` : ""}
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
      link.click();
      URL.revokeObjectURL(url);
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
    createdAt: batch.createdAt.toISOString(),
    files: batch.uploadedFiles.map((file) => ({
      id: file.id,
      filename: file.originalFilename,
      reportType: file.detectedReportType,
      status: file.parseStatus,
      rowCount: file.rowCount,
      warningCount: file.warningCount,
      errorMessage: file.errorMessage,
      rawCsvDownloadHref: file.rawContentBase64
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

function viewHref(view: View, batchId: string | null) {
  const params = new URLSearchParams();
  if (batchId) params.set("batch", batchId);
  const query = params.size ? `?${params}` : "";
  return `/app/${view}${query}`;
}
function viewLabel(view: View) {
  return view.charAt(0).toUpperCase() + view.slice(1);
}
function humanize(value: string) {
  return value
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
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
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
function fileKey(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
