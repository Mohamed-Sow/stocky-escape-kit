import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  BillingInterval,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { BILLING_PLANS } from "./models/billing.server";
import { upsertInstalledStore } from "./models/store.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.July26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  future: {
    expiringOfflineAccessTokens: true,
  },
  billing: {
    [BILLING_PLANS.basic]: {
      amount: 99,
      currencyCode: "USD",
      interval: BillingInterval.OneTime,
    },
    [BILLING_PLANS.pro]: {
      amount: 199,
      currencyCode: "USD",
      interval: BillingInterval.OneTime,
    },
    [BILLING_PLANS.plus]: {
      amount: 299,
      currencyCode: "USD",
      interval: BillingInterval.OneTime,
    },
  },
  hooks: {
    afterAuth: async ({ session }) => {
      await upsertInstalledStore({
        shop: session.shop,
        scopes: session.scope ?? null,
      });
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.July26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
