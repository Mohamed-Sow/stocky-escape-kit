import db from "../db.server";

export async function upsertInstalledStore({
  shop,
  scopes,
}: {
  shop: string;
  scopes: string | null;
}) {
  return db.store.upsert({
    where: { shop },
    create: {
      shop,
      scopes,
    },
    update: {
      installed: true,
      scopes,
      uninstalledAt: null,
    },
  });
}
