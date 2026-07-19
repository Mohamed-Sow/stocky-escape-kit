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
              Keep the original CSV evidence, compare SKU and location gaps
              against Shopify, and leave with a reviewable action list—not a
              promise that historical purchase orders can be imported.
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
              barcodes, vendors, and locations using read-only GraphQL access.
            </p>
          </article>
          <article>
            <h3>Hand off actionable work</h3>
            <p>
              Export every audit finding, supplier evidence, and a checklist
              that separates blockers from manual follow-up.
            </p>
          </article>
        </div>
      </section>

      <section className={styles.truthPanel}>
        <div>
          <p className={styles.eyebrow}>Important boundary</p>
          <h2>Supplier records need reconstruction</h2>
        </div>
        <p>
          Shopify&apos;s transition guidance says suppliers cannot be exported
          directly from Stocky. Preserve supplier clues from purchase orders and
          custom SKU reports, then recreate the records manually.{" "}
          <a href="https://help.shopify.com/en/manual/products/inventory/transitioning-from-stocky">
            Read Shopify&apos;s transition guidance
          </a>
          .
        </p>
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
