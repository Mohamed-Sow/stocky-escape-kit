import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Stocky Escape Kit</h1>
        <p className={styles.text}>
          Back up your Stocky records, find what will not migrate cleanly, and
          get a clear action list before Stocky shuts down.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Archive exports</strong>. Preserve Stocky CSV files and
            normalized import metadata for migration reference.
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
