import type { AssetScope, JsonObject } from "@work-shape/catalyst-core";
import { clientInstanceId, type DataStoreInstance } from "./data-store-instance";
import { applyAtCurrentRevisions } from "./asset-revisions";
import { required } from "./assertions";

export const kb = (name: string, store?: string): JsonObject => ({
  name,
  title: name,
  description: "Reference ownership fixture",
  ...(store
    ? {
        methods: ["structured"],
        backend: { dataStore: store },
        tables: [{ name: "items", description: "Items" }]
      }
    : { methods: ["keyword"] })
});
export const store = (name: string): JsonObject => ({ name, title: name, migrations: [] });
export const writerHeaders = { "x-dev-user-id": "writer" };
export const auth = {
  enabled: true,
  users: [
    { id: "admin", roles: ["user", "admin", "superadmin"] },
    { id: "writer", roles: ["user"] }
  ].map((u) => ({
    ...u,
    externalUserId: u.id,
    displayLabel: u.id,
    permissionRefs: [],
    permissions: u.id === "writer" ? ["config_assets.read", "config_assets.write"] : []
  }))
};

export async function seed(
  world: Pick<DataStoreInstance, "stores">,
  kind: string,
  config: JsonObject,
  scope: AssetScope = { kind: "instance" },
  published = false
) {
  const name = required(typeof config.name === "string" ? config.name : undefined);
  await applyAtCurrentRevisions(world.stores.configAssets, {
    clientInstanceId,
    mutations: [
      {
        type: "upsert",
        kind,
        name,
        config,
        scope,
        ...(kind === "agent" ? {} : { draft: true })
      }
    ]
  });
  const asset = required(
    await world.stores.configAssets.getConfigAsset({ clientInstanceId, kind, name })
  );
  if (published && kind !== "agent")
    await world.stores.configAssets.publishConfigAssetRevision({
      clientInstanceId,
      kind,
      name,
      assetId: asset.id,
      revision: asset.revision,
      revisionId: asset.activeRevisionId
    });
  return asset;
}

export function put(
  world: DataStoreInstance,
  kind: string,
  config: JsonObject,
  workspaceId?: string,
  headers: Record<string, string> = {}
): ReturnType<DataStoreInstance["api"]["call"]> {
  return world.api.call("assets.put", {
    params: { kind, name: required(typeof config.name === "string" ? config.name : undefined) },
    payload: {
      config,
      expectedRevision: null,
      ...(workspaceId ? { workspaceId } : {})
    },
    headers
  });
}
