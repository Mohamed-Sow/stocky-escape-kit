import type { Prisma } from "@prisma/client";
import { SyncStatus } from "@prisma/client";
import db from "../db.server";

type GraphqlClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

export type CatalogVariant = {
  id: string;
  sku: string | null;
  barcode: string | null;
  displayName: string;
  productId: string;
  productTitle: string;
  vendor: string | null;
  inventoryItemId: string | null;
  inventorySku: string | null;
  unitCost: {
    amount: string;
    currencyCode: string;
  } | null;
  locations: Array<{
    id: string;
    name: string;
    quantities: Record<string, number>;
  }>;
};

export type CatalogSummary = {
  generatedAt: string;
  truncated: boolean;
  limit: number;
  variants: CatalogVariant[];
  duplicateSkus: Array<{
    sku: string;
    count: number;
    variants: string[];
  }>;
  locations: Array<{
    id: string;
    name: string;
  }>;
};

type ProductVariantsResponse = {
  data?: {
    productVariants: {
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
      edges: Array<{
        cursor: string;
        node: {
          id: string;
          sku: string | null;
          barcode: string | null;
          displayName: string;
          product: {
            id: string;
            title: string;
            vendor: string | null;
          };
          inventoryItem: {
            id: string;
            sku: string | null;
            unitCost: {
              amount: string;
              currencyCode: string;
            } | null;
            inventoryLevels: {
              edges: Array<{
                node: {
                  location: {
                    id: string;
                    name: string;
                  };
                  quantities: Array<{
                    name: string;
                    quantity: number;
                  }>;
                };
              }>;
            };
          } | null;
        };
      }>;
    };
  };
  errors?: Array<{ message: string }>;
};

type ProductVariantNode = NonNullable<
  ProductVariantsResponse["data"]
>["productVariants"]["edges"][number]["node"];

type LocationsResponse = {
  data?: {
    locations: {
      pageInfo: {
        hasNextPage: boolean;
        endCursor: string | null;
      };
      edges: Array<{
        node: {
          id: string;
          name: string;
        };
      }>;
    };
  };
  errors?: Array<{ message: string }>;
};

type LocationNode = NonNullable<
  LocationsResponse["data"]
>["locations"]["edges"][number]["node"];

const PRODUCT_VARIANTS_QUERY = `#graphql
  query StockyEscapeKitProductVariants($cursor: String) {
    productVariants(first: 100, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        cursor
        node {
          id
          sku
          barcode
          displayName
          product {
            id
            title
            vendor
          }
          inventoryItem {
            id
            sku
            unitCost {
              amount
              currencyCode
            }
            inventoryLevels(first: 100) {
              edges {
                node {
                  location {
                    id
                    name
                  }
                  quantities(names: ["available", "on_hand", "incoming", "committed"]) {
                    name
                    quantity
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const LOCATIONS_QUERY = `#graphql
  query StockyEscapeKitLocations($cursor: String) {
    locations(first: 100, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          name
        }
      }
    }
  }
`;

export async function syncShopifyCatalog({
  admin,
  storeId,
}: {
  admin: GraphqlClient;
  storeId: string;
}) {
  const snapshot = await db.shopifyCatalogSnapshot.create({
    data: {
      storeId,
      syncStatus: SyncStatus.RUNNING,
    },
  });

  try {
    const limit = Number(process.env.SHOPIFY_SYNC_VARIANT_LIMIT ?? 5000);
    const variants = await fetchCatalogVariants({ admin, limit });
    const locations = await fetchLocations(admin);
    const summary = buildCatalogSummary({ variants, locations, limit });
    const productCount = new Set(variants.map((variant) => variant.productId))
      .size;
    const inventoryItemCount = new Set(
      variants
        .map((variant) => variant.inventoryItemId)
        .filter((id): id is string => Boolean(id)),
    ).size;
    const inventoryLevelCount = variants.reduce(
      (sum, variant) => sum + variant.locations.length,
      0,
    );

    return db.shopifyCatalogSnapshot.update({
      where: { id: snapshot.id },
      data: {
        syncStatus: SyncStatus.SUCCEEDED,
        productCount,
        variantCount: variants.length,
        inventoryItemCount,
        inventoryLevelCount,
        locationCount: locations.length,
        summary: summary as Prisma.InputJsonObject,
        syncedAt: new Date(),
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown Shopify sync error.";

    return db.shopifyCatalogSnapshot.update({
      where: { id: snapshot.id },
      data: {
        syncStatus: SyncStatus.FAILED,
        errorMessage: message,
      },
    });
  }
}

export function readCatalogSummary(value: Prisma.JsonValue | null) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const summary = value as Partial<CatalogSummary>;

  if (!Array.isArray(summary.variants)) {
    return null;
  }

  return summary as CatalogSummary;
}

async function fetchCatalogVariants({
  admin,
  limit,
}: {
  admin: GraphqlClient;
  limit: number;
}) {
  const variants: CatalogVariant[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage && variants.length < limit) {
    const payload: ProductVariantsResponse =
      await requestGraphql<ProductVariantsResponse>(admin, {
        query: PRODUCT_VARIANTS_QUERY,
        variables: { cursor },
      });
    const connection = payload.data?.productVariants;

    if (!connection) {
      throw new Error("Shopify productVariants query returned no data.");
    }

    for (const edge of connection.edges) {
      variants.push(normalizeVariant(edge.node));

      if (variants.length >= limit) {
        break;
      }
    }

    cursor = connection.pageInfo.endCursor;
    hasNextPage = connection.pageInfo.hasNextPage;
  }

  return variants;
}

async function fetchLocations(admin: GraphqlClient) {
  const locations: CatalogSummary["locations"] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const payload: LocationsResponse = await requestGraphql<LocationsResponse>(
      admin,
      {
        query: LOCATIONS_QUERY,
        variables: { cursor },
      },
    );
    const connection = payload.data?.locations;

    if (!connection) {
      throw new Error("Shopify locations query returned no data.");
    }

    locations.push(...connection.edges.map((edge): LocationNode => edge.node));
    cursor = connection.pageInfo.endCursor;
    hasNextPage = connection.pageInfo.hasNextPage;
  }

  return locations;
}

async function requestGraphql<
  T extends { errors?: Array<{ message: string }> },
>(
  admin: GraphqlClient,
  {
    query,
    variables,
  }: {
    query: string;
    variables?: Record<string, unknown>;
  },
) {
  const response = await admin.graphql(query, { variables });
  const payload = (await response.json()) as T;

  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }

  return payload;
}

function normalizeVariant(node: ProductVariantNode): CatalogVariant {
  const inventoryItem = node.inventoryItem;

  return {
    id: node.id,
    sku: clean(node.sku),
    barcode: clean(node.barcode),
    displayName: node.displayName,
    productId: node.product.id,
    productTitle: node.product.title,
    vendor: clean(node.product.vendor),
    inventoryItemId: inventoryItem?.id ?? null,
    inventorySku: clean(inventoryItem?.sku ?? null),
    unitCost: inventoryItem?.unitCost ?? null,
    locations:
      inventoryItem?.inventoryLevels.edges.map((edge) => ({
        id: edge.node.location.id,
        name: edge.node.location.name,
        quantities: Object.fromEntries(
          edge.node.quantities.map((quantity) => [
            quantity.name,
            quantity.quantity,
          ]),
        ),
      })) ?? [],
  };
}

function buildCatalogSummary({
  variants,
  locations,
  limit,
}: {
  variants: CatalogVariant[];
  locations: CatalogSummary["locations"];
  limit: number;
}): CatalogSummary {
  const variantsBySku = new Map<string, CatalogVariant[]>();

  for (const variant of variants) {
    if (!variant.sku) {
      continue;
    }

    const sku = variant.sku.toLowerCase();
    variantsBySku.set(sku, [...(variantsBySku.get(sku) ?? []), variant]);
  }

  const duplicateSkus = [...variantsBySku.entries()]
    .filter(([, matches]) => matches.length > 1)
    .map(([sku, matches]) => ({
      sku,
      count: matches.length,
      variants: matches.map((match) => match.displayName),
    }));

  return {
    generatedAt: new Date().toISOString(),
    truncated: variants.length >= limit,
    limit,
    variants,
    duplicateSkus,
    locations,
  };
}

function clean(value: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
