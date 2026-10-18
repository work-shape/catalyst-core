import {
  AppError,
  type AssetKindRegistry,
  type ClientInstanceId,
  type ConfigAssetStore,
  type OperationResource
} from "@work-shape/catalyst-core";

/**
 * A declared right must see the stored asset's id and owner, including after deletion.
 * Resolve incomplete resources here for initial calls, paged reads and calls resumed after
 * approval. Complete resources and resources of other kinds need no store read.
 */
export async function resolveOperationResource(
  options: {
    clientInstanceId: ClientInstanceId;
    stores: { configAssets: Pick<ConfigAssetStore, "getConfigAsset"> };
    configAssets?: { kinds: Pick<AssetKindRegistry, "get"> };
  },
  resource: OperationResource | undefined
): Promise<OperationResource | undefined> {
  if (!resource || (resource.assetId !== undefined && resource.assetId.length > 0)) return resource;
  const assetKind = options.configAssets?.kinds.get(resource.kind);
  if (!assetKind && resource.name === undefined) return resource;
  const asset = await options.stores.configAssets.getConfigAsset({
    clientInstanceId: options.clientInstanceId,
    kind: resource.kind,
    name: resource.name ?? resource.id
  });
  if (!asset) {
    if (!assetKind) return resource;
    throw new AppError(
      "INTERNAL",
      `An operation resource of asset kind '${resource.kind}' has no resolvable asset identity`
    );
  }
  // The stored owner wins over a caller or builder's incomplete resource.
  const { workspaceId: _workspaceId, ...declared } = resource;
  return {
    ...declared,
    assetId: asset.id,
    ...(asset.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {})
  };
}
