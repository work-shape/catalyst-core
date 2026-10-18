import { workflowDataFlowsSchema } from "@work-shape/catalyst-core";
import {
  WORKFLOW_ACTIONS,
  WORKFLOW_ASSET_KIND,
  workflowStepsDeep,
  type ActorAccess,
  type ClientInstanceId,
  type ConfigAssetRecord,
  type ConfigAssetStore
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { assetResource } from "./store-audience";

/** Existing provenance read bound; a further asset is reported through `truncated`. */
export const DATA_STORE_USED_BY_MAX_ASSETS = 1_000;

const publishedManifest = z.object({
  manifest: z.object({ kind: z.literal("data"), name: z.string(), steps: z.unknown() })
});

type Target = { kind: "knowledge_base" | "data_store"; name: string };

/** Derive from the live revision alone, never a draft or a reverse link kept on the target. */
export function workflowDataFlows(
  assets: readonly ConfigAssetRecord[],
  target: Target,
  access: ActorAccess
): z.infer<typeof workflowDataFlowsSchema> | undefined {
  const result: z.infer<typeof workflowDataFlowsSchema> = {
    fills: [],
    processes: [],
    hidden: { fills: 0, processes: 0 },
    truncated: assets.length > DATA_STORE_USED_BY_MAX_ASSETS
  };
  for (const asset of assets.slice(0, DATA_STORE_USED_BY_MAX_ASSETS)) {
    if (asset.status !== "active" || !asset.publishedRevisionId) continue;
    const parsed = publishedManifest.safeParse(asset.publishedConfig);
    if (!parsed.success) continue;
    const operations = new Set(
      [...workflowStepsDeep(parsed.data.manifest.steps)].flatMap((step) =>
        step.type === "operation" && typeof step.operation === "string" ? [step.operation] : []
      )
    );
    const prefix = `${target.kind === "knowledge_base" ? "knowledge" : "data_store"}.${target.name}.`;
    const fills =
      target.kind === "knowledge_base"
        ? ["ingest", "withdraw"].some((verb) => operations.has(prefix + verb))
        : ["insert", "load", "records.propose"].some((verb) => operations.has(prefix + verb));
    const processes =
      target.kind === "knowledge_base" &&
      operations.has(prefix + "pending") &&
      operations.has(prefix + "put_processed");
    // The published view of an asset is readable through read or use, as assets.get serves it.
    const readable = [WORKFLOW_ACTIONS.read, WORKFLOW_ACTIONS.use].some(
      (action) => access.authorize(action, assetResource(asset)).allowed
    );
    for (const role of ["fills", "processes"] as const) {
      if (!(role === "fills" ? fills : processes)) continue;
      if (readable)
        result[role].push({ id: asset.id, name: asset.name, title: parsed.data.manifest.name });
      else result.hidden[role]++;
    }
  }
  for (const role of ["fills", "processes"] as const) {
    result[role].sort(
      (left, right) => left.title.localeCompare(right.title) || left.name.localeCompare(right.name)
    );
  }
  return result.fills.length ||
    result.processes.length ||
    result.hidden.fills ||
    result.hidden.processes ||
    result.truncated
    ? result
    : undefined;
}

/** A Knowledge Base has no other provenance read to share this bounded metadata scan with. */
export async function readWorkflowDataFlows(
  stores: { configAssets: ConfigAssetStore },
  clientInstanceId: ClientInstanceId,
  target: Target,
  access: ActorAccess
): Promise<z.infer<typeof workflowDataFlowsSchema> | undefined> {
  const assets = await stores.configAssets.listPublishedConfigAssets({
    clientInstanceId,
    kind: WORKFLOW_ASSET_KIND,
    limit: DATA_STORE_USED_BY_MAX_ASSETS + 1
  });
  return workflowDataFlows(assets, target, access);
}
