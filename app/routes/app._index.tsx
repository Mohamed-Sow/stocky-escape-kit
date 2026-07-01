import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  await db.store.upsert({
    where: { shop: session.shop },
    create: {
      shop: session.shop,
      scopes: session.scope ?? null,
    },
    update: {
      installed: true,
      scopes: session.scope ?? null,
      uninstalledAt: null,
    },
  });

  return {
    shop: session.shop,
    scopes: session.scope ?? "read_products,read_inventory,read_locations",
  };
};

export default function Index() {
  const { shop, scopes } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Stocky Escape Kit">
      <s-section heading="Archive Stocky before shutdown">
        <s-paragraph>
          Back up your Stocky CSV exports, find records that will not migrate
          cleanly, and get a clear action list before Stocky shuts down on
          August 31, 2026.
        </s-paragraph>
        <s-unordered-list>
          <s-list-item>Purchase order exports for historical reference.</s-list-item>
          <s-list-item>Stocktakes and inventory activity exports.</s-list-item>
          <s-list-item>Historical cost, product, and vendor-like exports.</s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section heading="Migration audit scope">
        <s-paragraph>
          V1 is limited to Stocky shutdown migration, CSV archive, supplier
          reconstruction, and inventory readiness checks.
        </s-paragraph>
        <s-unordered-list>
          <s-list-item>Missing SKUs and duplicate SKUs.</s-list-item>
          <s-list-item>Missing cost, barcode, vendor, and location matches.</s-list-item>
          <s-list-item>Open purchase order indicators for manual follow-up.</s-list-item>
          <s-list-item>Supplier reconstruction candidates.</s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section slot="aside" heading="Shopify connection">
        <s-paragraph>
          <s-text>Shop: </s-text>
          <s-text>{shop}</s-text>
        </s-paragraph>
        <s-paragraph>
          <s-text>Scopes: </s-text>
          <s-text>{scopes}</s-text>
        </s-paragraph>
        <s-paragraph>
          Shopify access is read-only and uses the Admin GraphQL API.
        </s-paragraph>
      </s-section>

      <s-section slot="aside" heading="V1 boundaries">
        <s-paragraph>
          This app does not import historical Stocky purchase orders into
          Shopify and does not replace inventory management software.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
