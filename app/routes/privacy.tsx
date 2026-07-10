import styles from "../styles/public-info.module.css";

export default function PrivacyPolicy() {
  return (
    <main className={styles.page}>
      <article className={styles.article}>
        <p className={styles.eyebrow}>Stocky Escape Kit</p>
        <h1>Privacy policy</h1>
        <p className={styles.updated}>Effective July 10, 2026</p>

        <p>
          Stocky Escape Kit helps Shopify merchants preserve Stocky CSV exports,
          compare them with a read-only Shopify catalog snapshot, review migration
          findings, and create downloadable reports.
        </p>

        <h2>Information the app processes</h2>
        <ul>
          <li>
            Shopify product, variant, inventory item, inventory level, and
            location data obtained through read-only GraphQL Admin API access.
          </li>
          <li>
            Stocky CSV files supplied by the merchant, including original file
            bytes, filenames, parsed rows, unfamiliar columns, warnings, and
            SHA-256 checksums.
          </li>
          <li>
            Installation, subscription, scope, audit, export, and operational
            records needed to provide and secure the app.
          </li>
        </ul>

        <h2>How information is used</h2>
        <p>
          Information is used only to operate the migration archive, compare
          merchant-supplied records with the Shopify catalog, surface migration
          risks, preserve source evidence, provide exports, troubleshoot the
          service, and meet legal obligations. The app does not sell merchant
          data or use it for advertising.
        </p>

        <h2>Access and sharing</h2>
        <p>
          The app requests only read_products, read_inventory, and read_locations.
          It does not request customer data and does not create or change Shopify
          products, inventory, locations, customers, or purchase orders. Service
          providers may process data only as needed to host, secure, and operate
          the app or when required by law.
        </p>

        <h2>Retention and deletion</h2>
        <p>
          Migration uploads, raw files, catalog snapshots, findings, and export
          records remain available so the merchant can preserve a traceable
          migration record. An authenticated store administrator can permanently
          delete that store&apos;s migration data from Settings. Required Shopify
          privacy webhooks also remove covered store data when applicable.
        </p>

        <h2>Security and merchant choices</h2>
        <p>
          Access is store-scoped and authenticated through Shopify. Merchants can
          download preserved files and reports, delete migration data from the
          app, or uninstall the app to revoke Shopify access.
        </p>

        <h2>Contact</h2>
        <p>
          For privacy or support questions, use the developer contact shown on the
          Stocky Escape Kit listing in the Shopify App Store or visit the {" "}
          <a href="/support">support page</a>.
        </p>
      </article>
    </main>
  );
}
