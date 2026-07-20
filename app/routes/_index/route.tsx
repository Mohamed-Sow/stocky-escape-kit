import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect } from "react-router";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

export const meta: MetaFunction = () => [
  { title: "Stocky Escape Kit — preserve and audit Stocky exports" },
  {
    name: "description",
    content:
      "Preserve Stocky CSV evidence, compare it with Shopify, and leave with an actionable migration record before Stocky shuts down.",
  },
];

export default function App() {
  return (
    <main className={styles.index}>
      <header className={styles.hero}>
        <nav className={styles.nav} aria-label="Public navigation">
          <strong>Stocky Escape Kit</strong>
          <span>
            <a href="/support">Support</a>
            <a href="/privacy">Privacy</a>
          </span>
        </nav>
        <div className={styles.heroGrid}>
          <div>
            <p className={styles.eyebrow}>Stocky shuts down August 31, 2026</p>
            <h1 className={styles.heading}>
              Preserve the history Stocky will not move for you.
            </h1>
            <p className={styles.lede}>
              Keep the original CSV evidence, compare SKU gaps and reported
              location names against Shopify, and leave with a reviewable action
              list—not a promise that historical purchase orders can be
              imported.
            </p>
            <a className={styles.primaryLink} href="https://admin.shopify.com/">
              Open Shopify admin
            </a>
            <p className={styles.signInNote}>
              Installs and sign-ins begin from Shopify-owned surfaces. We never
              ask you to type a shop domain here.
            </p>
          </div>
          <aside className={styles.deadlineCard}>
            <p className={styles.eyebrow}>
              Export before Stocky becomes read-only
            </p>
            <ol>
              <li>Export completed purchase order reports.</li>
              <li>
                Export open purchase orders so remaining work can be reviewed
                and recreated safely.
              </li>
              <li>Export stocktake history.</li>
              <li>Export historical stock-on-hand or cost reports.</li>
              <li>
                Add product, custom SKU, and inventory activity reports when
                they provide useful supporting evidence.
              </li>
              <li>Keep every original CSV in a separate safe location.</li>
            </ol>
            <p className={styles.deadlineNote}>
              Shopify says read-only export access will continue for at least 90
              days after August 31. Operational Stocky workflows and APIs still
              stop on the shutdown date, so finish the cutover first.
            </p>
          </aside>
        </div>
      </header>

      <section className={styles.content} aria-labelledby="outcomes-heading">
        <p className={styles.eyebrow}>Merchant outcomes</p>
        <h2 id="outcomes-heading">A migration record you can defend</h2>
        <div className={styles.outcomes}>
          <article>
            <h3>Preserve source evidence</h3>
            <p>
              Store original CSV bytes, filenames, hashes, unfamiliar columns,
              parsed rows, and warnings without replacing earlier runs.
            </p>
          </article>
          <article>
            <h3>Find real reconciliation gaps</h3>
            <p>
              Compare Stocky SKUs with Shopify products, variants, costs,
              barcodes, vendors, and current location names using read-only
              GraphQL access. The app does not infer per-SKU quantities by
              location.
            </p>
          </article>
          <article>
            <h3>Hand off actionable work</h3>
            <p>
              Export every audit finding, supplier evidence, a cutover
              checklist, and Shopify-format draft line-item files for open
              purchase orders that can be derived safely.
            </p>
          </article>
        </div>
      </section>

      <section className={styles.truthPanel}>
        <div>
          <p className={styles.eyebrow}>Important boundaries</p>
          <h2>Know what can—and cannot—move</h2>
        </div>
        <div className={styles.truthCopy}>
          <p>
            <strong>Supplier records need reconstruction.</strong>{" "}
            Shopify&apos;s transition guidance says suppliers cannot be exported
            directly from Stocky. Preserve supplier clues from purchase orders
            and custom SKU reports, then recreate the records manually.{" "}
            <a href="https://help.shopify.com/en/manual/products/inventory/transitioning-from-stocky">
              Read Shopify&apos;s transition guidance
            </a>
            .
          </p>
          <p>
            <strong>Open work is not historical history.</strong> Open Stocky
            purchase-order rows can be packaged into Shopify&apos;s current
            draft line-item CSV format when identity and remaining quantity are
            safe. Ambiguous or duplicate rows are withheld for manual review.
          </p>
        </div>
      </section>

      <footer className={styles.footer}>
        <span>Stocky Escape Kit</span>
        <span>
          Read-only Shopify access · No inventory writes · No historical PO
          import claims
        </span>
      </footer>
    </main>
  );
}
