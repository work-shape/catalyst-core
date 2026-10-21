import {
  WORKFLOW_ASSET_KIND,
  type ConfigAssetRecord,
  type OperationResource
} from "@work-shape/catalyst-core";

/**
 * The resource a right over a Workflow is asked on: its name and, when it is stored, its id and
 * the workspace that owns it. A resource with an asset id is complete to the call path, which
 * reads no owner for it, so a workspace's Workflow names its workspace here or its deny and its
 * grants are not asked (WS-OWN-1b).
 */
export function workflowResource(
  name: string,
  asset: Pick<ConfigAssetRecord, "id" | "scope"> | undefined
): OperationResource & { kind: typeof WORKFLOW_ASSET_KIND; name: string } {
  return {
    kind: WORKFLOW_ASSET_KIND,
    id: asset?.id ?? name,
    name,
    ...(asset ? { assetId: asset.id } : {}),
    ...(asset?.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {})
  };
}
