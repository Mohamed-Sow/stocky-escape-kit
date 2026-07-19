import type { LoginError } from "@shopify/shopify-app-react-router/server";
import { LoginErrorType } from "@shopify/shopify-app-react-router/server";

interface LoginErrorMessage {
  shop?: string;
}

export function loginErrorMessage(loginErrors: LoginError): LoginErrorMessage {
  if (loginErrors?.shop === LoginErrorType.MissingShop) {
    return { shop: "Open Stocky Escape Kit from Shopify admin to sign in." };
  } else if (loginErrors?.shop === LoginErrorType.InvalidShop) {
    return {
      shop: "This Shopify install link is invalid. Return to Shopify admin and open Stocky Escape Kit from Apps.",
    };
  }

  return {};
}
