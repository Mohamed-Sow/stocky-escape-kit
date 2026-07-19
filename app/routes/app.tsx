import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, redirect, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { NavMenu } from "@shopify/app-bridge-react";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (isDirectDocumentRequestWithoutShopifyContext(request)) {
    throw redirect("/");
  }

  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <NavMenu>
        <a href="/app">Migration kit</a>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

function isDirectDocumentRequestWithoutShopifyContext(request: Request) {
  if (request.method !== "GET" || request.headers.get("authorization")) {
    return false;
  }

  const url = new URL(request.url);
  const hasShopifyContext = [
    "shop",
    "host",
    "id_token",
    "hmac",
    "embedded",
    "session",
    "timestamp",
  ].some((key) => url.searchParams.has(key));
  const fetchDestination = request.headers.get("sec-fetch-dest");
  const acceptsHtml = request.headers.get("accept")?.includes("text/html");
  const isDocument =
    fetchDestination === "document" ||
    fetchDestination === "iframe" ||
    (!fetchDestination && acceptsHtml && !url.searchParams.has("_data"));

  return Boolean(isDocument && !hasShopifyContext);
}
