import { AppProvider } from "@shopify/shopify-app-react-router/react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const errors = url.searchParams.get("shop")
    ? loginErrorMessage(await login(request))
    : {};

  return { errors };
};

export default function Auth() {
  const { errors } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded={false}>
      <s-page>
        <s-section heading="Open Stocky Escape Kit from Shopify">
          <p>
            For security, installs and sign-ins start from a Shopify-owned
            surface. Open Shopify admin, then choose Stocky Escape Kit from
            Apps. This page never asks you to type a store domain.
          </p>
          {errors.shop ? <p role="alert">{errors.shop}</p> : null}
          <p>
            <a href="https://admin.shopify.com/" target="_top">
              Open Shopify admin
            </a>
          </p>
          <p>
            <a href="/support">Support</a> · <a href="/privacy">Privacy</a>
          </p>
        </s-section>
      </s-page>
    </AppProvider>
  );
}
