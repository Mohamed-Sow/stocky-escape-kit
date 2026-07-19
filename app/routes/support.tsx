import { useLoaderData } from "react-router";
import { getSupportEmail } from "../lib/support.server";
import styles from "../styles/public-info.module.css";

export const loader = () => ({ supportEmail: getSupportEmail() });

export default function Support() {
  const { supportEmail } = useLoaderData<typeof loader>();

  return (
    <main className={styles.page}>
      <article className={styles.article}>
        <p className={styles.eyebrow}>Stocky Escape Kit</p>
        <h1>Support</h1>
        <p className={styles.updated}>Stocky shutdown migration help</p>

        <p>
          Stocky Escape Kit preserves merchant-supplied Stocky exports, audits
          migration gaps against read-only Shopify catalog data, and produces a
          reviewable handoff package.
        </p>

        <h2>Before requesting help</h2>
        <ul>
          <li>Keep the original Stocky CSV files available.</li>
          <li>Note the migration run date and affected filename.</li>
          <li>
            Do not send passwords, Shopify access tokens, or other secrets.
          </li>
          <li>
            Preserve the raw archive download when reporting a parsing problem.
          </li>
        </ul>

        <h2>Contact support</h2>
        {supportEmail ? (
          <p>
            Email <a href={`mailto:${supportEmail}`}>{supportEmail}</a>. Include
            the store domain, migration run date, affected filename, and a short
            description of the issue. Never include credentials or access
            tokens.
          </p>
        ) : (
          <p>
            Use the merchant support contact shown on the Stocky Escape Kit
            listing in the Shopify App Store. The production support email must
            be configured before review.
          </p>
        )}

        <h2>Product boundary</h2>
        <p>
          Historical Stocky purchase orders are preserved and reviewed as
          migration evidence. They are not imported into Shopify. The app does
          not perform Shopify inventory writes.
        </p>
        <p>
          Catalog audits currently support stores with up to 5,000 Shopify
          variants. A larger catalog stops before findings are generated rather
          than returning a partial audit.
        </p>

        <p>
          Read the <a href="/privacy">privacy policy</a> for data handling and
          deletion details.
        </p>
      </article>
    </main>
  );
}
