#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const API_VERSION = "2026-07";
const REQUIRED_SCOPES = ["read_products", "read_inventory", "read_locations"];
const BILLING_PLAN_NAMES = [
  "Stocky Escape Kit Basic",
  "Stocky Escape Kit Pro",
  "Stocky Escape Kit Plus",
  "Stocky Escape Kit Review Test",
];

const mode = process.argv.includes("--static") ? "static" : "live";

loadDotEnv();

const staticFailures = runStaticChecks();

if (mode === "static") {
  finish(staticFailures, {
    success: "Static Shopify smoke prerequisites passed.",
    failure: "Static Shopify smoke prerequisites failed.",
  });
}

if (staticFailures.length > 0) {
  finish(staticFailures, {
    failure:
      "Live Shopify smoke test cannot run until static prerequisites pass.",
  });
}

const liveFailures = await runLiveChecks();

finish(liveFailures, {
  success: "Live Shopify smoke test passed.",
  failure: "Live Shopify smoke test failed.",
});

function runStaticChecks() {
  const failures = [];
  const envExamplePath = path.join(process.cwd(), ".env.example");
  const shopifyConfigPath = path.join(process.cwd(), "shopify.app.toml");
  const publicIndexRoutePath = path.join(
    process.cwd(),
    "app/routes/_index/route.tsx",
  );
  const packageJsonPath = path.join(process.cwd(), "package.json");
  const buildOutputCheckPath = path.join(
    process.cwd(),
    "scripts/check-build-output.mjs",
  );
  const appRoutePath = path.join(process.cwd(), "app/routes/app._index.tsx");
  const exportRoutePath = path.join(
    process.cwd(),
    "app/routes/app.exports.$type.tsx",
  );
  const shopifyServerPath = path.join(process.cwd(), "app/shopify.server.ts");
  const oneTimePurchaseWebhookPath = path.join(
    process.cwd(),
    "app/routes/webhooks.app_purchases_one_time.update.tsx",
  );
  const prismaSchemaCheckPath = path.join(
    process.cwd(),
    "scripts/check-prisma-schema.mjs",
  );

  if (!existsSync(envExamplePath)) {
    failures.push(".env.example is missing.");
  } else {
    const envExample = readFileSync(envExamplePath, "utf8");
    for (const key of [
      "DATABASE_URL",
      "SHOPIFY_API_KEY",
      "SHOPIFY_API_SECRET",
      "SHOPIFY_APP_URL",
      "SHOPIFY_APP_HANDLE",
      "SHOPIFY_BILLING_TEST",
      "SHOPIFY_SYNC_VARIANT_LIMIT",
      "SHOPIFY_TEST_SHOP",
      "SHOPIFY_ADMIN_ACCESS_TOKEN",
      "SHOPIFY_SMOKE_ENDPOINT_URL",
      "SHOPIFY_SMOKE_TOKEN",
    ]) {
      if (!envExample.includes(`${key}=`)) {
        failures.push(`.env.example is missing ${key}.`);
      }
    }
  }

  if (!existsSync(shopifyConfigPath)) {
    failures.push("shopify.app.toml is missing.");
  } else {
    const shopifyConfig = readFileSync(shopifyConfigPath, "utf8");
    const applicationUrl = readTomlString(shopifyConfig, "application_url");
    const expectedCallbackUrl = applicationUrl
      ? `${applicationUrl}/auth/callback`
      : null;

    if (!applicationUrl) {
      failures.push("shopify.app.toml is missing application_url.");
    }

    if (expectedCallbackUrl && !shopifyConfig.includes(expectedCallbackUrl)) {
      failures.push(
        `shopify.app.toml auth.redirect_urls must include ${expectedCallbackUrl}.`,
      );
    }

    if (shopifyConfig.includes("/api/auth")) {
      failures.push(
        "shopify.app.toml auth.redirect_urls must not point at /api/auth; the app uses the /auth route prefix.",
      );
    }

    for (const scope of REQUIRED_SCOPES) {
      if (!shopifyConfig.includes(scope)) {
        failures.push(`shopify.app.toml is missing ${scope}.`);
      }
    }

    if (shopifyConfig.includes("app_purchases_one_time/update")) {
      failures.push(
        "shopify.app.toml still registers the obsolete one-time purchase webhook.",
      );
    }
  }

  if (!existsSync(publicIndexRoutePath)) {
    failures.push("app/routes/_index/route.tsx is missing.");
  } else {
    const publicIndexRoute = readFileSync(publicIndexRoutePath, "utf8");
    if (publicIndexRoute.includes('action="/auth/login"')) {
      failures.push(
        "Public root must not render a manual shop-domain login form for App Store install flow.",
      );
    }
  }

  if (!existsSync(packageJsonPath)) {
    failures.push("package.json is missing.");
  } else {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (
      packageJson.scripts?.["risk:audit"] !==
      "npm run smoke:shopify:static && npm run test:local && node scripts/check-prisma-schema.mjs && npm run typecheck && npm run lint && node scripts/check-build-output.mjs"
    ) {
      failures.push("package.json is missing the risk:audit script.");
    }
    if (
      packageJson.scripts?.["test:local"] !==
      "vite-node scripts/risk-regression-tests.ts"
    ) {
      failures.push("package.json is missing the test:local script.");
    }
    if (
      packageJson.scripts?.["smoke:shopify"] !==
      "node scripts/smoke-shopify-live.mjs"
    ) {
      failures.push("package.json is missing the smoke:shopify script.");
    }
    if (
      packageJson.scripts?.["smoke:shopify:static"] !==
      "node scripts/smoke-shopify-live.mjs --static"
    ) {
      failures.push("package.json is missing the smoke:shopify:static script.");
    }
  }

  if (!existsSync(buildOutputCheckPath)) {
    failures.push("scripts/check-build-output.mjs is missing.");
  }

  if (existsSync(oneTimePurchaseWebhookPath)) {
    failures.push(
      "Obsolete one-time purchase webhook route still exists; Shopify App Pricing should not depend on it.",
    );
  }

  if (!existsSync(shopifyServerPath)) {
    failures.push("app/shopify.server.ts is missing.");
  } else {
    const shopifyServer = readFileSync(shopifyServerPath, "utf8");
    if (
      shopifyServer.includes("BillingInterval") ||
      shopifyServer.includes("OneTime") ||
      /billing\s*:/.test(shopifyServer)
    ) {
      failures.push(
        "app/shopify.server.ts still configures Billing API charges instead of Shopify App Pricing.",
      );
    }
  }

  for (const routePath of [appRoutePath, exportRoutePath]) {
    if (!existsSync(routePath)) {
      failures.push(`${path.relative(process.cwd(), routePath)} is missing.`);
      continue;
    }

    const source = readFileSync(routePath, "utf8");
    if (source.includes("billing.request")) {
      failures.push(
        `${path.relative(
          process.cwd(),
          routePath,
        )} still creates in-app Billing API charges.`,
      );
    }
    if (source.includes("oneTimePurchases")) {
      failures.push(
        `${path.relative(
          process.cwd(),
          routePath,
        )} still accepts one-time purchases for review readiness.`,
      );
    }
  }

  if (!existsSync(prismaSchemaCheckPath)) {
    failures.push("scripts/check-prisma-schema.mjs is missing.");
  }

  return failures;
}

function readTomlString(toml, key) {
  const match = toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"));

  return match?.[1] ?? null;
}

async function runLiveChecks() {
  const failures = [];
  const shop = normalizeShop(process.env.SHOPIFY_TEST_SHOP);
  const directAccessToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN?.trim();
  const smokeEndpointUrl = process.env.SHOPIFY_SMOKE_ENDPOINT_URL?.trim();
  const smokeToken = process.env.SHOPIFY_SMOKE_TOKEN?.trim();

  if (!process.env.SHOPIFY_TEST_SHOP) {
    failures.push(
      "SHOPIFY_TEST_SHOP is required for the live smoke test. Add it to .env or export it before running npm run smoke:shopify.",
    );
  }

  if (process.env.SHOPIFY_TEST_SHOP && !shop) {
    failures.push("SHOPIFY_TEST_SHOP must be a myshopify.com shop domain.");
  }

  if (smokeEndpointUrl && !smokeToken) {
    failures.push(
      "SHOPIFY_SMOKE_TOKEN is required when SHOPIFY_SMOKE_ENDPOINT_URL is set.",
    );
  }

  if (!directAccessToken && !process.env.DATABASE_URL && !smokeEndpointUrl) {
    failures.push(
      "Set SHOPIFY_ADMIN_ACCESS_TOKEN for direct GraphQL proof, DATABASE_URL for Prisma offline-session proof, or SHOPIFY_SMOKE_ENDPOINT_URL plus SHOPIFY_SMOKE_TOKEN for hosted smoke proof.",
    );
  }

  if (failures.length > 0) {
    return failures;
  }

  if (smokeEndpointUrl) {
    return verifyHostedSmokeEndpoint({
      endpointUrl: smokeEndpointUrl,
      shop,
      smokeToken,
    });
  }

  if (directAccessToken) {
    return verifyAdminGraphql({
      shop,
      accessToken: directAccessToken,
      tokenSource: "SHOPIFY_ADMIN_ACCESS_TOKEN",
    });
  }

  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();

  try {
    const session = await prisma.session.findFirst({
      where: {
        shop,
        isOnline: false,
      },
      orderBy: {
        id: "asc",
      },
    });

    if (!session?.accessToken) {
      return [
        `No offline Shopify session found for ${shop}. Run npm run dev, install the app on that dev store, then rerun npm run smoke:shopify.`,
      ];
    }

    return verifyAdminGraphql({
      shop,
      accessToken: session.accessToken,
      tokenSource: "Prisma offline session",
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function verifyHostedSmokeEndpoint({ endpointUrl, shop, smokeToken }) {
  let response;
  let payload;

  try {
    const url = new URL(endpointUrl);
    url.searchParams.set("shop", shop);

    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${smokeToken}`,
      },
    });
    payload = await response.json();
  } catch (error) {
    return [
      error instanceof Error
        ? `Hosted Shopify smoke endpoint failed: ${error.message}`
        : "Hosted Shopify smoke endpoint failed with an unknown error.",
    ];
  }

  if (!response.ok || payload.ok !== true) {
    const remoteFailures = Array.isArray(payload.failures)
      ? payload.failures.join("; ")
      : payload.error;
    return [
      `Hosted Shopify smoke endpoint returned HTTP ${response.status}: ${
        remoteFailures || "unknown failure"
      }`,
    ];
  }

  const grantedScopes = Array.isArray(payload.grantedScopes)
    ? payload.grantedScopes
    : [];
  const missingScopes = REQUIRED_SCOPES.filter(
    (scope) => !grantedScopes.includes(scope),
  );
  const failures = [];

  if (payload.shop !== shop) {
    failures.push(
      `Hosted Shopify smoke endpoint returned shop ${payload.shop ?? "unknown"} instead of ${shop}.`,
    );
  }

  if (missingScopes.length > 0) {
    failures.push(
      `Installed app is missing scopes: ${missingScopes.join(", ")}.`,
    );
  }

  if (!BILLING_PLAN_NAMES.includes(payload.billingName)) {
    failures.push(
      `No active Stocky Escape Kit App Pricing subscription was found for ${shop}.`,
    );
  }

  if (typeof payload.productSamples !== "number") {
    failures.push("Hosted Shopify smoke endpoint returned no product sample count.");
  }

  if (typeof payload.locationSamples !== "number") {
    failures.push(
      "Hosted Shopify smoke endpoint returned no location sample count.",
    );
  }

  if (failures.length === 0) {
    printLiveSummary({
      shop,
      tokenSource: payload.tokenSource ?? "Hosted smoke endpoint",
      grantedScopes,
      billingName: payload.billingName,
      productSamples: payload.productSamples,
      locationSamples: payload.locationSamples,
    });
  }

  return failures;
}

async function verifyAdminGraphql({ shop, accessToken, tokenSource }) {
  const failures = [];
  let payload;

  try {
    payload = await adminGraphql({
      shop,
      accessToken,
    });
  } catch (error) {
    return [
      error instanceof Error
        ? error.message
        : "Unknown Shopify GraphQL smoke-test failure.",
    ];
  }

  const installation = payload.data?.currentAppInstallation;
  const grantedScopes =
    installation?.accessScopes.map((scope) => scope.handle) ?? [];
  const missingScopes = REQUIRED_SCOPES.filter(
    (scope) => !grantedScopes.includes(scope),
  );

  if (missingScopes.length > 0) {
    failures.push(
      `Installed app is missing scopes: ${missingScopes.join(", ")}.`,
    );
  }

  const activeSubscription = installation?.activeSubscriptions.find(
    (subscription) =>
      subscription.status === "ACTIVE" &&
      BILLING_PLAN_NAMES.includes(subscription.name),
  );

  if (!activeSubscription) {
    failures.push(
      `No active Stocky Escape Kit App Pricing subscription was found for ${shop}.`,
    );
  }

  if (!payload.data?.products) {
    failures.push("GraphQL products query returned no connection.");
  }

  if (!payload.data?.locations) {
    failures.push("GraphQL locations query returned no connection.");
  }

  if (failures.length === 0) {
    printLiveSummary({
      shop,
      tokenSource,
      grantedScopes,
      billingName: activeSubscription?.name ?? "",
      productSamples: payload.data.products.edges.length,
      locationSamples: payload.data.locations.edges.length,
    });
  }

  return failures;
}

async function adminGraphql({ shop, accessToken }) {
  const response = await fetch(
    `https://${shop}/admin/api/${API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query: `#graphql
          query StockyEscapeKitLiveSmoke {
            currentAppInstallation {
              accessScopes {
                handle
              }
              activeSubscriptions {
                name
                status
                test
              }
            }
            products(first: 1) {
              edges {
                node {
                  id
                  title
                }
              }
            }
            locations(first: 1) {
              edges {
                node {
                  id
                  name
                }
              }
            }
          }
        `,
      }),
    },
  );

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(
      `Shopify GraphQL returned HTTP ${response.status}: ${JSON.stringify(payload)}`,
    );
  }

  if (payload.errors?.length) {
    throw new Error(
      `Shopify GraphQL errors: ${payload.errors
        .map((error) => error.message)
        .join("; ")}`,
    );
  }

  return payload;
}

function loadDotEnv() {
  const dotenvPath = path.join(process.cwd(), ".env");

  if (!existsSync(dotenvPath)) {
    return;
  }

  for (const line of readFileSync(dotenvPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);

    if (!match || process.env[match[1]] !== undefined) {
      continue;
    }

    process.env[match[1]] = stripQuotes(match[2]);
  }
}

function stripQuotes(value) {
  const trimmed = value.trim();

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function normalizeShop(value) {
  if (!value) {
    return null;
  }

  const shop = value.trim().toLowerCase();

  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop)) {
    return null;
  }

  return shop;
}

function printLiveSummary({
  shop,
  tokenSource,
  grantedScopes,
  billingName,
  productSamples,
  locationSamples,
}) {
  console.log(`Shop: ${shop}`);
  console.log(`Token source: ${tokenSource}`);
  console.log(`Billing: ${billingName}`);
  console.log(`Granted scopes: ${grantedScopes.sort().join(", ")}`);
  console.log(`Products query sample rows: ${productSamples}`);
  console.log(`Locations query sample rows: ${locationSamples}`);
}

function finish(failures, { success, failure }) {
  if (failures.length === 0) {
    console.log(success);
    process.exit(0);
  }

  console.error(failure);
  for (const item of failures) {
    console.error(`- ${item}`);
  }
  process.exit(mode === "static" ? 1 : 2);
}
