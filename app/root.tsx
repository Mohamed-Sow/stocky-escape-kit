import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useLoaderData,
  useRouteError,
  type LoaderFunctionArgs,
} from "react-router";
import styles from "./styles/public-info.module.css";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);

  return {
    // Shopify's preliminary App Bridge check also requests the configured app
    // URL directly. The embedded /app shell loads this script through the
    // official AppProvider, while the public root needs its own marker.
    publicAppBridgeApiKey:
      url.pathname === "/" ? process.env.SHOPIFY_API_KEY || "" : "",
  };
}

export default function App() {
  const { publicAppBridgeApiKey } = useLoaderData<typeof loader>();

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        {publicAppBridgeApiKey ? (
          <>
            <meta name="shopify-api-key" content={publicAppBridgeApiKey} />
            <script
              src="https://cdn.shopify.com/shopifycloud/app-bridge.js"
              data-api-key={publicAppBridgeApiKey}
            />
          </>
        ) : null}
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 500;

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <main className={styles.page}>
          <article className={styles.article}>
            <p className={styles.eyebrow}>Stocky Escape Kit</p>
            <h1>
              {status === 404 ? "Page not found" : "The app could not open"}
            </h1>
            <p>
              {status === 404
                ? "The requested page does not exist."
                : "Open the app from Shopify admin and try again. If the problem continues, contact support."}
            </p>
            <p>
              <a href="https://admin.shopify.com/">Open Shopify admin</a> ·{" "}
              <a href="/support">Support</a>
            </p>
          </article>
        </main>
        <Scripts />
      </body>
    </html>
  );
}
