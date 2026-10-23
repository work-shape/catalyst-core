import type { Asset } from "@work-shape/catalyst-api-contract";
import { workflowStepsDeep, type ActorAccess, type JsonObject } from "@work-shape/catalyst-core";
import { accessResource, listedTo, readsAssetDraft } from "../assets/asset-access";
import { assetTitle } from "../assets/asset-reference-labels";
import type { AssetWorkflowOptions } from "../types";

/** Reverse step references from the revisions the reader may see, including unpublished drafts. */
export async function workflowCallers(
  options: AssetWorkflowOptions,
  workflow: string,
  access: ActorAccess
): Promise<NonNullable<Asset["workflowCallers"]>> {
  const kind = options.configAssets.kinds.get("workflow");
  if (!kind) return [];
  const callers: NonNullable<Asset["workflowCallers"]> = [];
  let afterName: string | undefined;
  const limit = 200;
  for (;;) {
    const assets = await options.configAssets.store.listActiveConfigAssets({
      clientInstanceId: options.clientInstanceId,
      kind: "workflow",
      afterName,
      limit
    });
    const visible = assets.filter((asset) => {
      return listedTo(kind, access, {
        ...asset,
        published: asset.publishedRevisionId !== undefined
      });
    });
    // Active discovery omits published content. Read both pointers together for visible keys.
    const revisions = await options.configAssets.store.listConfigAssetsByKey({
      clientInstanceId: options.clientInstanceId,
      keys: visible.map(({ kind, name }) => ({ kind, name }))
    });
    const byName = new Map(revisions.map((asset) => [asset.name, asset]));
    for (const key of visible) {
      const asset = byName.get(key.name);
      if (asset?.status !== "active") continue;
      const resource = accessResource(asset.kind, asset.name, asset.scope, asset.id);
      const draft = readsAssetDraft(kind, access, resource);
      const published = [kind.actions.read, kind.actions.write, kind.actions.use].some(
        (action) => action !== undefined && access.authorize(action, resource).allowed
      );
      if (!(
        (draft && calls(asset.config, workflow)) ||
        (published && calls(asset.publishedConfig, workflow))
      ))
        continue;
      const config = draft ? asset.config : asset.publishedConfig;
      callers.push({
        name: asset.name,
        title: config
          ? assetTitle(options.configAssets.kinds.kinds, "workflow", asset.name, config, undefined)
          : asset.name,
        scope: asset.scope
      });
    }
    if (assets.length < limit) return callers;
    const last = assets.at(-1);
    if (!last || (afterName !== undefined && last.name <= afterName))
      throw new Error("Workflow caller discovery cursor did not advance");
    afterName = last.name;
  }
}

function calls(config: JsonObject | null | undefined, workflow: string): boolean {
  const manifest = config?.manifest;
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return false;
  return workflowStepsDeep(manifest.steps).some(
    (step) => step.type === "workflow" && step.workflow === workflow
  );
}
