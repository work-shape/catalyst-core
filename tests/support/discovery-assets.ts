import type {
  AssetScope,
  ConfigAssetStore,
  JsonObject,
  OperationRegistry
} from "@work-shape/catalyst-core";
import { vi } from "vitest";
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

/** Observe the real registry results without adding another complete discovery walk. */
export function captureOperationListings(registry: OperationRegistry) {
  const list = registry.list.bind(registry);
  const listings: Awaited<ReturnType<OperationRegistry["list"]>>[] = [];
  vi.spyOn(registry, "list").mockImplementation(async (scope) => {
    const result = await list(scope);
    listings.push(result);
    return result;
  });
  return listings;
}
