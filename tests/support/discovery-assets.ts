import type { AssetScope, ConfigAssetStore, JsonObject } from "@work-shape/catalyst-core";
import { clientInstanceId } from "./access-instance";
import { withTestSql } from "./test-sql";

/** Bulk fixture rows use the store's write path; only immutable published pointers are advanced. */
export async function seedDiscoveryAssets(
  configAssets: ConfigAssetStore,
  kind: string,
  names: readonly string[],
  config: (name: string) => JsonObject,
  scope?: AssetScope
) {
  await configAssets.applyConfigAssetMutations({
    clientInstanceId,
    baseRevisions: Object.fromEntries(names.map((name) => [`${kind}:${name}`, null])),
    mutations: names.map((name) => ({
      type: "upsert",
      kind,
      name,
      config: config(name),
      draft: true,
      ...(scope ? { scope } : {})
    }))
  });
  // These revisions never change in a discovery fixture. Publishing each separately adds
  // a read and a transaction per asset without exercising any discovery behavior. Preserve
  // the real write path and point the whole immutable batch at those stored revisions.
  await withTestSql(async (sql) => {
    const published = await sql<{ name: string }[]>`
      update config_assets set published_revision_id = active_revision_id, updated_at = now()
      where client_instance_id = ${clientInstanceId} and kind = ${kind}
        and name = any(${[...names]}::text[]) and status = 'active'
      returning name`;
    if (published.length !== names.length) throw new Error("Discovery fixture asset is missing");
  });
}

export const discoveryNames = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(4, "0")}`);
