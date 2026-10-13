import {
  DATA_STORE_ACTIONS,
  DATA_STORE_OPERATION_PREFIX,
  WORKFLOW_ACTIONS,
  WORKFLOW_ASSET_KIND,
  type ActorAccess,
  type ConfigAssetRecord,
  type OperationDefinition
} from "@vivd-catalyst/core";
import { z } from "zod";
import type { DataStoreRuntime } from "./runtime";
import type { PublishedStore } from "./verbs";

// What uses one store: the published Apps whose `sql` actions name it and the published
// Workflows whose operation steps call one of its operations. It is read from the published
// definitions each time, so it is as true as they are and no second record can fall behind.

/**
 * How many published Apps and how many published Workflows one read looks through. An
 * instance with more is answered from the first ones by name, and `truncated` says so.
 */
const DATA_STORE_USED_BY_MAX_ASSETS = 1_000;
/** How long the read may take, in milliseconds. It reads no database of a store. */
const DATA_STORE_USED_BY_TIMEOUT_MS = 15_000;
/** How deep the blocks of a Workflow are followed for their steps. */
const DATA_STORE_USED_BY_MAX_BLOCK_DEPTH = 16;

/** The kind of an App and the rights that show one, as the kind `app` registers them. */
const APP = { kind: "app", read: "app.read", use: "app.use" } as const;

const usingSchema = z.object({ id: z.string(), name: z.string(), title: z.string() });

const usedByOutputSchema = z.object({
  /** The published Apps and Workflows that use the store and that the caller may be shown. */
  apps: z.array(usingSchema),
  workflows: z.array(usingSchema),
  /** How many more use it that the caller may not be shown. Nothing of them is told. */
  hidden: z.object({ apps: z.number().int(), workflows: z.number().int() }),
  /** More published Apps or Workflows exist than one read looks through. */
  truncated: z.boolean()
});

type UsedBy = z.infer<typeof usedByOutputSchema>;

const appConfigSchema = z.object({
  title: z.string().optional(),
  manifest: z.object({ actions: z.array(z.unknown()) })
});
const sqlActionSchema = z.object({ kind: z.literal("sql"), dataStore: z.string() });

const workflowConfigSchema = z.object({
  manifest: z.object({ name: z.string().optional(), steps: z.array(z.unknown()) })
});
const stepSchema = z.object({
  type: z.string(),
  operation: z.string().optional(),
  steps: z.array(z.unknown()).optional()
});

/** Whether a step, or a step of a block it holds, calls an operation of the store. */
function stepCalls(step: unknown, prefix: string, depth = 0): boolean {
  const read = stepSchema.safeParse(step);
  if (!read.success || depth > DATA_STORE_USED_BY_MAX_BLOCK_DEPTH) return false;
  return (
    (read.data.type === "operation" && read.data.operation?.startsWith(prefix) === true) ||
    (read.data.steps ?? []).some((inner) => stepCalls(inner, prefix, depth + 1))
  );
}

/** The title of an App that uses the store, or nothing where its published revision does not. */
function appUse(asset: ConfigAssetRecord, store: string): string | undefined {
  const config = appConfigSchema.safeParse(asset.publishedConfig);
  if (!config.success) return undefined;
  const uses = config.data.manifest.actions.some((action) => {
    const sql = sqlActionSchema.safeParse(action);
    return sql.success && sql.data.dataStore === store;
  });
  return uses ? (config.data.title ?? asset.name) : undefined;
}

function workflowUse(asset: ConfigAssetRecord, store: string): string | undefined {
  const config = workflowConfigSchema.safeParse(asset.publishedConfig);
  if (!config.success) return undefined;
  const prefix = `${DATA_STORE_OPERATION_PREFIX}${store}.`;
  return config.data.manifest.steps.some((step) => stepCalls(step, prefix))
    ? (config.data.manifest.name ?? asset.name)
    : undefined;
}

async function usedBy(
  runtime: DataStoreRuntime,
  store: PublishedStore,
  access: ActorAccess
): Promise<UsedBy> {
  const { clientInstanceId, stores } = runtime;
  const published = (kind: string) =>
    stores.configAssets.listPublishedConfigAssets({
      clientInstanceId,
      kind,
      limit: DATA_STORE_USED_BY_MAX_ASSETS + 1
    });
  const [apps, workflows] = await Promise.all([
    published(APP.kind),
    published(WORKFLOW_ASSET_KIND)
  ]);
  /** Splits the assets that use the store into the ones the caller is shown and a count. */
  const sorted = (
    assets: readonly ConfigAssetRecord[],
    use: (asset: ConfigAssetRecord, name: string) => string | undefined,
    rights: readonly string[]
  ) => {
    const shown: UsedBy["apps"] = [];
    let hidden = 0;
    for (const asset of assets.slice(0, DATA_STORE_USED_BY_MAX_ASSETS)) {
      if (asset.status !== "active") continue;
      const title = use(asset, store.record.name);
      if (title === undefined) continue;
      const resource = {
        kind: asset.kind,
        name: asset.name,
        assetId: asset.id,
        ...(asset.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {})
      };
      // The published revision of an asset is shown to whoever reads it or uses it, as its
      // list shows it. Nobody else learns that it exists, here as there.
      if (rights.some((right) => access.authorize(right, resource).allowed)) {
        shown.push({ id: asset.id, name: asset.name, title });
      } else {
        hidden += 1;
      }
    }
    return { shown, hidden };
  };
  const usingApps = sorted(apps, appUse, [APP.read, APP.use]);
  const usingWorkflows = sorted(workflows, workflowUse, [
    WORKFLOW_ACTIONS.read,
    WORKFLOW_ACTIONS.use
  ]);
  return {
    apps: usingApps.shown,
    workflows: usingWorkflows.shown,
    hidden: { apps: usingApps.hidden, workflows: usingWorkflows.hidden },
    truncated: Math.max(apps.length, workflows.length) > DATA_STORE_USED_BY_MAX_ASSETS
  };
}

/** The last part of the name of the operation that answers what uses a store. */
export const DATA_STORE_USED_BY_PART = "used_by";

/**
 * The read of what uses one store. It needs `data_store.read` on the store and reads no row
 * of it, so a call that completes leaves no run.
 */
export function usedByOperation(
  runtime: DataStoreRuntime,
  store: PublishedStore,
  module: string
): OperationDefinition {
  return {
    name: `${DATA_STORE_OPERATION_PREFIX}${store.record.name}.${DATA_STORE_USED_BY_PART}`,
    effect: "reading",
    action: DATA_STORE_ACTIONS.read,
    scope: "config_assets:read",
    auth: "principal",
    inputSchema: z.strictObject({}),
    outputSchema: usedByOutputSchema,
    resource: () => store.resource,
    module,
    timeoutMs: DATA_STORE_USED_BY_TIMEOUT_MS,
    execute: (_input, context) => usedBy(runtime, store, context.access)
  };
}
