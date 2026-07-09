import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

export default function App() {
  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Stocky Escape Kit</h1>
        <p className={styles.text}>
          Parse Stocky exports, find what will not migrate cleanly, and get a
          clear action list before Stocky shuts down.
        </p>
        <ul className={styles.list}>
          <li>
            <strong>Parsed archive</strong>. Preserve normalized Stocky rows,
            unknown columns, file hashes, and import metadata for migration
            reference.
          </li>
          <li>
            <strong>Audit gaps</strong>. Match Stocky rows to Shopify SKUs,
            products, variants, inventory items, and locations.
          </li>
          <li>
            <strong>Prepare fixes</strong>. Report missing fields, duplicate
            SKUs, location mismatches, and supplier reconstruction candidates.
          </li>
        </ul>
      </div>
    </div>
  );
}
