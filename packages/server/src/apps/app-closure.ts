import {
  AppError,
  WORKFLOW_ASSET_KIND,
  appReachesDataStore,
  type AssetScope,
  type ConfigAssetRecord,
  type JsonObject
} from "@work-shape/catalyst-core";
import type { AssetWorkflowOptions } from "../types";

// The Workflows an App's revision reaches (DP-3): those its `workflow` actions name and,
// through the revision of each that would be live, their child Workflows. It is computed when
// it is needed and never stored. Spec: events-workflows-and-guardrails.md, LIVE-2; the
// drafts-together design, section 3.

type ClosureOptions = Pick<AssetWorkflowOptions, "clientInstanceId" | "configAssets">;

/** One Workflow of an App's closure. */
export interface ClosureWorkflow {
  name: string;
  /** Its row, where an active Workflow of the name stands where the App reaches it. */
  asset: ConfigAssetRecord | undefined;
}

/**
 * The Workflows `config`, an App's revision, reaches, children before the Workflows that start
 * them, each once. `liveConfig` says which revision of a Workflow its children are read from:
 * the one that would be live. A Workflow that is missing, inactive or out of the App's reach is
 * listed without its row and its children are not read.
 */
export async function appWorkflowClosure(
  options: ClosureOptions,
  app: { scope: AssetScope; config: JsonObject },
  liveConfig: (asset: ConfigAssetRecord) => JsonObject | undefined
): Promise<ClosureWorkflow[]> {
  const ordered: ClosureWorkflow[] = [];
  const seen = new Set<string>();
  const workflowsOf = (kind: string, config: JsonObject) =>
    (options.configAssets.kinds.get(kind)?.references?.(config) ?? [])
      .filter((reference) => reference.kind === WORKFLOW_ASSET_KIND)
      .map(({ name }) => name);
  const visit = async (name: string): Promise<void> => {
    if (seen.has(name)) return;
    seen.add(name);
    const row = await options.configAssets.store.getConfigAsset({
      clientInstanceId: options.clientInstanceId,
      kind: WORKFLOW_ASSET_KIND,
      name
    });
    const asset =
      row?.status === "active" && appReachesDataStore(app.scope, row.scope) ? row : undefined;
    const config = asset ? liveConfig(asset) : undefined;
    for (const child of config ? workflowsOf(WORKFLOW_ASSET_KIND, config) : []) {
      await visit(child);
    }
    ordered.push({ name, asset });
  };
  for (const name of workflowsOf("app", app.config)) await visit(name);
  return ordered;
}

/** An asset's title as a person reads it: its own title, its manifest's name, or its name. */
export function assetTitle(config: JsonObject | null | undefined, name: string): string {
  const manifest = config?.manifest;
  const named =
    typeof config?.title === "string" && config.title.length > 0
      ? config.title
      : typeof manifest === "object" && manifest !== null && "name" in manifest
        ? manifest.name
        : undefined;
  return typeof named === "string" && named.length > 0 ? named : name;
}

/** A Workflow draft has changes its published revision does not, or was never published. */
export function workflowPending(asset: ConfigAssetRecord): boolean {
  return asset.publishedRevision === undefined || asset.publishedRevision !== asset.revision;
}

/**
 * The Workflows a publish of an App names to make live with it, checked against the App's
 * closure and ordered children first: each one once, active, reached by the App's revision
 * through the revisions that would be live, and named at a revision of its own.
 */
export async function workflowsPublishedWith(
  options: ClosureOptions,
  app: { scope: AssetScope; config: JsonObject },
  named: readonly { name: string; revision: number }[]
): Promise<{ name: string; revision: number; asset: ConfigAssetRecord }[]> {
  const revisions = new Map<string, number>();
  for (const { name, revision } of named) {
    if (revisions.has(name)) {
      throw new AppError("VALIDATION_FAILED", `The Workflow '${name}' is named twice`, {
        reason: "workflow_named_twice",
        workflow: name
      });
    }
    revisions.set(name, revision);
  }
  // The revision of each named Workflow that would be live is the one named.
  const configs = new Map<string, JsonObject>();
  for (const [name, revision] of revisions) {
    const stored = await options.configAssets.store.getConfigAssetRevision({
      clientInstanceId: options.clientInstanceId,
      kind: WORKFLOW_ASSET_KIND,
      name,
      revision
    });
    if (stored?.config) configs.set(name, stored.config);
  }
  const closure = await appWorkflowClosure(
    options,
    app,
    (asset) => configs.get(asset.name) ?? asset.publishedConfig
  );
  const reached = new Map(closure.map((member) => [member.name, member.asset]));
  for (const name of revisions.keys()) {
    if (!reached.get(name)) {
      throw new AppError(
        "VALIDATION_FAILED",
        `The App's revision does not reach the Workflow '${name}', so it is not published with it`,
        { reason: "workflow_not_reached", workflow: name },
        { exposeMessage: true }
      );
    }
  }
  return closure.flatMap(({ name, asset }) => {
    const revision = revisions.get(name);
    return asset && revision !== undefined ? [{ name, revision, asset }] : [];
  });
}
