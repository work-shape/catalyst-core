import {
  DATA_STORE_ASSET_KIND,
  type ConfigAssetRecord,
  type DataStoreRecord,
  type PlatformStores
} from "@work-shape/catalyst-core";
import { dataStoreDefinitionSchema } from "./definition";
import type { DataStoreRuntime } from "./runtime";
import type { PublishedStore } from "./verbs";

export function publishedStore(
  asset: ConfigAssetRecord,
  record: DataStoreRecord | undefined
): PublishedStore | undefined {
  const definition = dataStoreDefinitionSchema.safeParse(asset.publishedConfig);
  if (
    asset.status !== "active" ||
    !definition.success ||
    record?.id !== asset.id ||
    record.status === "retired"
  ) {
    return undefined;
  }
  return {
    definition: definition.data,
    record,
    resource: {
      kind: DATA_STORE_ASSET_KIND,
      title: definition.data.title,
      id: asset.id,
      assetId: asset.id,
      name: asset.name,
      ...(asset.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {})
    }
  };
}

/** One published store by its name: two reads, through the rows the caller hands in. */
export async function readStore(
  runtime: Pick<DataStoreRuntime, "clientInstanceId"> & {
    stores: {
      configAssets: Pick<PlatformStores["configAssets"], "getConfigAsset">;
      dataStores: Pick<PlatformStores["dataStores"], "getDataStore">;
    };
  },
  name: string
): Promise<PublishedStore | undefined> {
  const { clientInstanceId, stores } = runtime;
  const asset = await stores.configAssets.getConfigAsset({
    clientInstanceId,
    kind: DATA_STORE_ASSET_KIND,
    name
  });
  if (!asset) return undefined;
  return publishedStore(
    asset,
    await stores.dataStores.getDataStore({ clientInstanceId, id: asset.id })
  );
}
