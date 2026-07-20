import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { StockyReportType } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { strToU8, zipSync } from "fflate";
import db from "../db.server";
import { toCsv } from "./csv.server";
import { getOpenPurchaseOrderImportFilename } from "./export-filenames";
import { safeDownloadFilename } from "./filenames.server";
import {
  isOpenPurchaseOrderStatus,
  recoverOpenPurchaseOrderEvidence,
  resolveOpenPurchaseOrderQuantity,
} from "./open-purchase-orders";
import { formatShopifyDecimal, parseStockyDecimal } from "./stocky-numbers";

const PAGE_SIZE = 500;
const SHOPIFY_PURCHASE_ORDER_HEADERS = [
  "SKU",
  "Barcode",
  "Supplier SKU",
  "Quantity",
  "Cost",
  "Tax",
];

const RECORD_SELECT = {
  id: true,
  normalizedType: true,
  sourceRowNumber: true,
  sku: true,
  normalizedPayload: true,
  uploadedFile: {
    select: { originalFilename: true },
  },
} satisfies Prisma.ParsedRecordSelect;

type PurchaseOrderRecord = Prisma.ParsedRecordGetPayload<{
  select: typeof RECORD_SELECT;
}>;

type NormalizedPayload = {
  raw?: Record<string, string>;
  normalized?: {
    sku?: string | null;
    supplierSku?: string | null;
    barcode?: string | null;
    supplier?: string | null;
    vendor?: string | null;
    quantity?: string | null;
    quantityOrdered?: string | null;
    quantityReceived?: string | null;
    quantityOutstanding?: string | null;
    cost?: string | null;
    taxRate?: string | null;
    status?: string | null;
    reference?: string | null;
    location?: string | null;
    date?: string | null;
  };
};

type PreparedLine = {
  reference: string;
  sourceFile: string;
  sourceRow: number;
  status: string;
  sku: string;
  barcode: string;
  supplierSku: string;
  supplierEvidence: string;
  quantity: number;
  quantityBasis: string;
  cost: string;
  tax: string;
  sourceQuantity: string;
  sourceQuantityOrdered: string;
  sourceQuantityReceived: string;
  sourceQuantityOutstanding: string;
};

type ExcludedLine = Omit<PreparedLine, "quantity"> & {
  quantity: number | null;
  reason: string;
  nextAction: string;
};

export async function generateOpenPurchaseOrderImportPackage({
  storeId,
  batchId,
}: {
  storeId: string;
  batchId: string;
}) {
  const run = await db.uploadBatch.findFirst({
    where: { id: batchId, storeId },
    select: { createdAt: true },
  });

  if (!run) {
    throw new Error("The selected migration run was not found.");
  }

  const prepared: PreparedLine[] = [];
  const excluded: ExcludedLine[] = [];

  for await (const record of iteratePurchaseOrderRecords(storeId, batchId)) {
    const payload = readPayload(record.normalizedPayload);
    const normalized = recoverOpenPurchaseOrderEvidence(payload);
    const status = normalized.status?.trim() ?? "";

    if (!isOpenPurchaseOrderStatus(status)) {
      continue;
    }

    const reference = normalized.reference?.trim() ?? "";
    const sku = record.sku?.trim() || normalized.sku?.trim() || "";
    const barcode = normalized.barcode?.trim() ?? "";
    const supplierSku = normalized.supplierSku?.trim() ?? "";
    const supplierEvidence =
      normalized.supplier?.trim() || normalized.vendor?.trim() || "";
    const resolution = resolveOpenPurchaseOrderQuantity({
      status,
      quantity: normalized.quantity,
      quantityOrdered: normalized.quantityOrdered,
      quantityReceived: normalized.quantityReceived,
      quantityOutstanding: normalized.quantityOutstanding,
    });
    const shared = {
      reference,
      sourceFile: record.uploadedFile.originalFilename,
      sourceRow: record.sourceRowNumber,
      status,
      sku,
      barcode,
      supplierSku,
      supplierEvidence,
      quantityBasis: resolution.basis,
      cost: safeOptionalDecimal(normalized.cost, 2),
      tax: safeOptionalDecimal(normalized.taxRate, 2),
      sourceQuantity: normalized.quantity?.trim() ?? "",
      sourceQuantityOrdered: normalized.quantityOrdered?.trim() ?? "",
      sourceQuantityReceived: normalized.quantityReceived?.trim() ?? "",
      sourceQuantityOutstanding:
        normalized.quantityOutstanding?.trim() ?? "",
    };

    if (!reference) {
      excluded.push({
        ...shared,
        quantity: resolution.quantity,
        reason: "missing_purchase_order_reference",
        nextAction:
          "Identify the Stocky purchase order before recreating this line in Shopify.",
      });
      continue;
    }

    if (!sku && !barcode) {
      excluded.push({
        ...shared,
        quantity: resolution.quantity,
        reason: "missing_shopify_variant_identifier",
        nextAction:
          "Recover a Shopify SKU or barcode before adding this line to a purchase order.",
      });
      continue;
    }

    if (resolution.quantity === null) {
      excluded.push({
        ...shared,
        quantity: null,
        reason: "unsafe_remaining_quantity",
        nextAction: resolution.reason,
      });
      continue;
    }

    prepared.push({ ...shared, quantity: resolution.quantity });
  }

  const entries: Record<string, Uint8Array> = {};
  const readyGroups = groupByReference(prepared);
  const summaries: string[][] = [];
  const usedImportFilenames = new Set<string>();
  let readyLineCount = 0;

  for (const [reference, lines] of readyGroups) {
    const duplicateIdentifiers = duplicateVariantIdentifiers(lines);
    const safeLines = lines.filter((line) => {
      const identifier = variantIdentifier(line);

      if (!duplicateIdentifiers.has(identifier)) {
        return true;
      }

      excluded.push({
        ...line,
        reason: "duplicate_variant_within_purchase_order",
        nextAction:
          "Confirm whether these Stocky rows are duplicates or separate remaining quantities, then combine them manually before Shopify import.",
      });
      return false;
    });

    if (safeLines.length === 0) {
      summaries.push([
        reference,
        uniqueEvidence(lines.map((line) => line.supplierEvidence)),
        uniqueEvidence(lines.map((line) => line.status)),
        "0",
        String(lines.length),
        "manual review required",
      ]);
      continue;
    }

    const filename = `shopify-import/${uniqueReferenceFilename(
      reference,
      usedImportFilenames,
    )}.csv`;
    entries[filename] = strToU8(
      toCsv([
        SHOPIFY_PURCHASE_ORDER_HEADERS,
        ...safeLines.map((line) => [
          line.sku,
          line.barcode,
          line.supplierSku,
          String(line.quantity),
          line.cost,
          line.tax,
        ]),
      ]),
    );
    readyLineCount += safeLines.length;
    summaries.push([
      reference,
      uniqueEvidence(lines.map((line) => line.supplierEvidence)),
      uniqueEvidence(lines.map((line) => line.status)),
      String(safeLines.length),
      String(lines.length - safeLines.length),
      "verify before importing into a Shopify draft purchase order",
    ]);
  }

  entries["purchase-order-summary.csv"] = strToU8(
    toCsv([
      [
        "stocky_po_reference",
        "supplier_evidence",
        "source_statuses",
        "shopify_import_rows",
        "manual_review_rows",
        "next_action",
      ],
      ...summaries,
    ]),
  );
  entries["manual-review-lines.csv"] = strToU8(
    buildExcludedLinesCsv(excluded),
  );
  entries["README.txt"] = strToU8(buildReadme());

  const manifest = {
    format: "Stocky Escape Kit open purchase-order handoff",
    batchId,
    generatedAt: new Date().toISOString(),
    officialShopifyTemplate:
      "https://help.shopify.com/cdn/shopifycloud/help-center/csv/purchase_order_template.csv",
    readyPurchaseOrderCount: Object.keys(entries).filter((name) =>
      name.startsWith("shopify-import/"),
    ).length,
    readyLineCount,
    excludedLineCount: excluded.length,
    files: Object.entries(entries).map(([filename, bytes]) => ({
      filename,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(Buffer.from(bytes)).digest("hex"),
    })),
  };
  entries["manifest.json"] = strToU8(`${JSON.stringify(manifest, null, 2)}\n`);

  return {
    bytes: zipSync(entries, { level: 6 }),
    filename: getOpenPurchaseOrderImportFilename(run.createdAt),
    readyPurchaseOrderCount: manifest.readyPurchaseOrderCount,
    readyLineCount,
    excludedLineCount: excluded.length,
  };
}

async function* iteratePurchaseOrderRecords(
  storeId: string,
  batchId: string,
): AsyncGenerator<PurchaseOrderRecord> {
  let cursor: string | null = null;

  while (true) {
    const records: PurchaseOrderRecord[] = await db.parsedRecord.findMany({
      where: {
        uploadedFile: { batch: { storeId, id: batchId } },
      },
      orderBy: [
        { uploadedFileId: "asc" },
        { sourceRowNumber: "asc" },
        { id: "asc" },
      ],
      take: PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: RECORD_SELECT,
    });

    for (const record of records) {
      if (record.normalizedType === StockyReportType.PURCHASE_ORDERS) {
        yield record;
      }
    }

    if (records.length < PAGE_SIZE) {
      return;
    }

    cursor = records.at(-1)?.id ?? null;
  }
}

function buildExcludedLinesCsv(lines: ExcludedLine[]) {
  return toCsv([
    [
      "stocky_po_reference",
      "source_file",
      "source_row",
      "status",
      "sku",
      "barcode",
      "supplier_sku",
      "source_quantity",
      "quantity_ordered",
      "quantity_received",
      "quantity_remaining",
      "derived_shopify_quantity",
      "quantity_basis",
      "reason",
      "next_action",
    ],
    ...lines.map((line) => [
      line.reference,
      line.sourceFile,
      String(line.sourceRow),
      line.status,
      line.sku,
      line.barcode,
      line.supplierSku,
      line.sourceQuantity,
      line.sourceQuantityOrdered,
      line.sourceQuantityReceived,
      line.sourceQuantityOutstanding,
      line.quantity === null ? "" : String(line.quantity),
      line.quantityBasis,
      line.reason,
      line.nextAction,
    ]),
  ]);
}

function buildReadme() {
  return `STOCKY OPEN PURCHASE-ORDER HANDOFF\n\nThe shopify-import folder contains one CSV per Stocky purchase order. Each CSV uses Shopify's current official line-item import headers:\nSKU, Barcode, Supplier SKU, Quantity, Cost, Tax\n\nUse each file separately:\n1. In Shopify admin, go to Products > Purchase orders and create a draft purchase order.\n2. Select or create the supplier and choose the destination location.\n3. Import the matching CSV from shopify-import.\n4. Compare every line with the preserved Stocky source and manual-review-lines.csv.\n5. Confirm remaining quantities, costs, tax percentages, supplier currency, and destination before marking the purchase order as ordered.\n\nSafety rules:\n- These files recreate open work only. They do not import historical Stocky purchase orders as history.\n- Partial, in-transit, duplicate, unidentified, or non-positive lines are withheld when a safe remaining quantity cannot be derived.\n- A source quantity copied from an open or not-received line still requires merchant verification.\n- Shopify rejects duplicate variants already present on a purchase order; duplicate Stocky lines are withheld for manual consolidation.\n\nOfficial Shopify instructions:\nhttps://help.shopify.com/en/manual/products/inventory/purchase-orders/creating-purchase-orders\n`;
}

function groupByReference(lines: PreparedLine[]) {
  const groups = new Map<string, PreparedLine[]>();

  for (const line of lines) {
    groups.set(line.reference, [...(groups.get(line.reference) ?? []), line]);
  }

  return groups;
}

function duplicateVariantIdentifiers(lines: PreparedLine[]) {
  const counts = new Map<string, number>();

  for (const line of lines) {
    const identifier = variantIdentifier(line);
    counts.set(identifier, (counts.get(identifier) ?? 0) + 1);
  }

  return new Set(
    [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([identifier]) => identifier),
  );
}

function variantIdentifier(line: PreparedLine) {
  return line.sku
    ? `sku:${line.sku.toLowerCase()}`
    : `barcode:${line.barcode.toLowerCase()}`;
}

function safeOptionalDecimal(
  value: string | null | undefined,
  fractionDigits: number,
) {
  const parsed = parseStockyDecimal(value);
  return parsed !== null && parsed >= 0
    ? formatShopifyDecimal(value, fractionDigits)
    : "";
}

function referenceFilename(reference: string) {
  const safe = safeDownloadFilename(reference)
    .replace(/\.[^.]+$/, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 120);
  return safe || "stocky-purchase-order";
}

function uniqueReferenceFilename(reference: string, used: Set<string>) {
  const base = referenceFilename(reference);
  let candidate = base;
  let normalized = candidate.toLowerCase();

  if (used.has(normalized)) {
    const suffix = createHash("sha256").update(reference).digest("hex").slice(0, 8);
    candidate = `${base.slice(0, 111)}-${suffix}`;
    normalized = candidate.toLowerCase();
  }

  let counter = 2;
  while (used.has(normalized)) {
    candidate = `${base.slice(0, 113)}-${counter}`;
    normalized = candidate.toLowerCase();
    counter += 1;
  }

  used.add(normalized);
  return candidate;
}

function uniqueEvidence(values: string[]) {
  return [...new Set(values.filter(Boolean))].join("; ");
}

function readPayload(value: Prisma.JsonValue): NormalizedPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as NormalizedPayload;
}
