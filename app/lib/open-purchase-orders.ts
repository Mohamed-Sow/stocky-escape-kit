import { parseStockyInteger } from "./stocky-numbers";

export type OpenPurchaseOrderQuantityInput = {
  status?: string | null;
  quantity?: string | null;
  quantityOrdered?: string | null;
  quantityReceived?: string | null;
  quantityOutstanding?: string | null;
};

export type OpenPurchaseOrderEvidence = OpenPurchaseOrderQuantityInput & {
  sku: string | null;
  supplierSku: string | null;
  barcode: string | null;
  supplier: string | null;
  vendor: string | null;
  cost: string | null;
  taxRate: string | null;
  reference: string | null;
  location: string | null;
  date: string | null;
};

export type OpenPurchaseOrderQuantityResolution = {
  quantity: number | null;
  basis:
    | "explicit_remaining"
    | "ordered_minus_received"
    | "source_quantity"
    | "unavailable";
  reason: string;
};

export function isOpenPurchaseOrderStatus(
  status: string | null | undefined,
) {
  if (!status?.trim()) {
    return false;
  }

  const value = status.toLowerCase().replace(/[_-]+/g, " ");
  const openPatterns = [
    /\bpartially received\b/,
    /\bpartial\b/,
    /\bnot received\b/,
    /\bunreceived\b/,
    /\bin transit\b/,
    /\bback ?order(?:ed)?\b/,
    /\bopen\b/,
    /\bpending\b/,
    /\bordered\b/,
    /\bdraft\b/,
    /\bsent\b/,
    /\bsubmitted\b/,
    /\bapproved\b/,
  ];

  return openPatterns.some((pattern) => pattern.test(value));
}

export function resolveOpenPurchaseOrderQuantity(
  input: OpenPurchaseOrderQuantityInput,
): OpenPurchaseOrderQuantityResolution {
  const outstanding = parseStockyInteger(input.quantityOutstanding);

  if (outstanding !== null) {
    return outstanding > 0
      ? {
          quantity: outstanding,
          basis: "explicit_remaining",
          reason: "Used the source file's explicit remaining quantity.",
        }
      : {
          quantity: null,
          basis: "unavailable",
          reason: "The source file reports no remaining quantity.",
        };
  }

  const ordered = parseStockyInteger(input.quantityOrdered ?? input.quantity);
  const received = parseStockyInteger(input.quantityReceived);

  if (ordered !== null && received !== null) {
    const remaining = ordered - received;
    return remaining > 0
      ? {
          quantity: remaining,
          basis: "ordered_minus_received",
          reason: "Calculated ordered quantity minus received quantity.",
        }
      : {
          quantity: null,
          basis: "unavailable",
          reason: "Ordered quantity minus received quantity is not positive.",
        };
  }

  const status = input.status?.toLowerCase().replace(/[_-]+/g, " ") ?? "";
  if (/\b(partial|partially received|in transit|back ?order(?:ed)?)\b/.test(status)) {
    return {
      quantity: null,
      basis: "unavailable",
      reason:
        "The order is partial or in transit, but the source file does not expose a safe remaining quantity.",
    };
  }

  const sourceQuantity = parseStockyInteger(input.quantity);
  return sourceQuantity !== null && sourceQuantity > 0
    ? {
        quantity: sourceQuantity,
        basis: "source_quantity",
        reason:
          "Used the source quantity for an open, not-received, or draft line; verify it before importing.",
      }
    : {
        quantity: null,
        basis: "unavailable",
        reason: "No positive whole-number quantity could be derived safely.",
      };
}

export function recoverOpenPurchaseOrderEvidence(payload: {
  raw?: Record<string, string>;
  normalized?: Partial<OpenPurchaseOrderEvidence>;
}): OpenPurchaseOrderEvidence {
  const normalized = payload.normalized ?? {};
  const rawPrimarySku = rawValue(payload.raw, [
    "sku",
    "variant_sku",
    "product_sku",
    "stock_keeping_unit",
    "stock_code",
    "item_code",
    "item_id",
  ]);
  const rawSupplierSku = rawValue(payload.raw, [
    "supplier_sku",
    "vendor_sku",
    "supplier_ref",
    "supplier_reference",
    "supplier_item_code",
  ]);
  const normalizedSku = clean(normalized.sku);
  const supplierSku = clean(normalized.supplierSku) ?? rawSupplierSku;
  const sku =
    rawPrimarySku ??
    (normalizedSku && normalizedSku !== supplierSku ? normalizedSku : null);
  const rawSupplier = rawValue(payload.raw, ["supplier", "supplier_name"]);
  const normalizedSupplier = clean(normalized.supplier);

  return {
    sku,
    supplierSku,
    barcode:
      clean(normalized.barcode) ??
      rawValue(payload.raw, [
        "barcode",
        "bar_code",
        "ean",
        "upc",
        "gtin",
        "isbn",
        "variant_barcode",
      ]),
    supplier:
      rawSupplier ??
      (normalizedSupplier && normalizedSupplier !== supplierSku
        ? normalizedSupplier
        : null),
    vendor:
      clean(normalized.vendor) ??
      rawValue(payload.raw, ["vendor", "vendor_name", "brand"]),
    quantity:
      clean(normalized.quantity) ??
      rawValue(payload.raw, [
        "quantity",
        "qty",
        "qty_ordered",
        "quantity_ordered",
        "qty_received",
        "quantity_received",
        "total_items",
        "total_quantity",
      ]),
    quantityOrdered:
      clean(normalized.quantityOrdered) ??
      rawValue(payload.raw, [
        "qty_ordered",
        "quantity_ordered",
        "ordered_quantity",
        "order_qty",
      ]),
    quantityReceived:
      clean(normalized.quantityReceived) ??
      rawValue(payload.raw, [
        "qty_received",
        "quantity_received",
        "received_quantity",
        "received_qty",
      ]),
    quantityOutstanding:
      clean(normalized.quantityOutstanding) ??
      rawValue(payload.raw, [
        "qty_outstanding",
        "quantity_outstanding",
        "qty_remaining",
        "remaining_quantity",
        "unreceived_quantity",
        "qty_unreceived",
        "backordered_quantity",
      ]),
    cost:
      clean(normalized.cost) ??
      rawValue(payload.raw, [
        "cost",
        "unit_cost",
        "cost_base",
        "cost_price",
        "cost_per_item",
        "average_cost",
        "landed_cost",
        "unit_price",
      ]),
    taxRate:
      clean(normalized.taxRate) ??
      rawValue(payload.raw, [
        "tax",
        "tax_rate",
        "tax_percent",
        "tax_percentage",
      ]),
    status:
      clean(normalized.status) ??
      rawValue(payload.raw, [
        "status",
        "line_status",
        "po_status",
        "purchase_order_status",
        "received_status",
      ]),
    reference:
      clean(normalized.reference) ??
      rawValue(payload.raw, [
        "reference",
        "po",
        "p_o",
        "purchase_order",
        "purchase_order_number",
        "po_number",
        "p_o_number",
        "order_number",
        "supplier_order_number",
      ]),
    location:
      clean(normalized.location) ??
      rawValue(payload.raw, [
        "location",
        "location_name",
        "stock_location",
        "warehouse",
        "receive_location",
        "destination",
      ]),
    date:
      clean(normalized.date) ??
      rawValue(payload.raw, [
        "date",
        "created_at",
        "order_date",
        "po_date",
        "invoice_date",
        "expected_date",
      ]),
  };
}

function rawValue(raw: Record<string, string> | undefined, aliases: string[]) {
  if (!raw) return null;

  for (const [header, value] of Object.entries(raw)) {
    if (aliases.includes(normalizeHeader(header)) && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function normalizeHeader(header: string) {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function clean(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed || null;
}
