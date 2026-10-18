import type { AssetScope, ConfigAssetStore, JsonObject } from "@work-shape/catalyst-core";
import { clientInstanceId } from "./access-instance";

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
  for (const name of names) {
    const asset = await configAssets.getConfigAsset({ clientInstanceId, kind, name });
    if (!asset) throw new Error("Discovery fixture asset is missing");
    await configAssets.publishConfigAssetRevision({
      clientInstanceId,
      kind,
      name,
      assetId: asset.id,
      revision: asset.revision,
      revisionId: asset.activeRevisionId
    });
  }
}

export const discoveryNames = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${prefix}-${String(index).padStart(4, "0")}`);
