import { compiledActionsOf } from "@work-shape/catalyst-app-build";
import { APP_ASSET_KIND, type Asset } from "@work-shape/catalyst-api-contract";
import type { ActorAccess, JsonObject } from "@work-shape/catalyst-core";
import { accessResource, listedTo, readsAssetDraft } from "../assets/asset-access";
import { assetTitle } from "../assets/asset-reference-labels";
import type { AssetWorkflowOptions } from "../types";

/** One App whose `workflow` action starts a Workflow, as a Workflow's read or row names it. */
export type AppCaller = NonNullable<Asset["appCallers"]>[number];

/** How many Apps one read of the store asks for. */
const PAGE = 200;

/**
 * The Apps that start each Workflow through a `workflow` action, by Workflow name: read from
 * the App drafts and published revisions the reader may see, in one pass over the Apps, so a
 * list of Workflows asks once and not once per row. An App the reader may not open is left out,
 * not counted. Each Workflow's Apps are sorted by title. Derived each time from the revisions,
 * so no second record can fall behind them.
 */
export async function appCallersByWorkflow(
  options: AssetWorkflowOptions,
  access: ActorAccess
): Promise<Map<string, AppCaller[]>> {
  const byWorkflow = new Map<string, AppCaller[]>();
  const kind = options.configAssets.kinds.get(APP_ASSET_KIND);
  if (!kind) return byWorkflow;
  let afterName: string | undefined;
  for (;;) {
    const apps = await options.configAssets.store.listActiveConfigAssets({
      clientInstanceId: options.clientInstanceId,
      kind: APP_ASSET_KIND,
      afterName,
      limit: PAGE
    });
    const visible = apps.filter((app) =>
      listedTo(kind, access, { ...app, published: app.publishedRevisionId !== undefined })
    );
    // Active discovery omits published content. Read both pointers together for visible keys.
    const revisions = await options.configAssets.store.listConfigAssetsByKey({
      clientInstanceId: options.clientInstanceId,
      keys: visible.map(({ kind: assetKind, name }) => ({ kind: assetKind, name }))
    });
    const byName = new Map(revisions.map((app) => [app.name, app]));
    for (const key of visible) {
      const app = byName.get(key.name);
      if (app?.status !== "active") continue;
      const resource = accessResource(
        app.kind,
        app.name,
        app.scope,
        app.id,
        key.appAvailability ?? app.appAvailability
      );
      const draft = readsAssetDraft(kind, access, resource);
      const published = [kind.actions.read, kind.actions.write, kind.actions.use].some(
        (action) => action !== undefined && access.authorize(action, resource).allowed
      );
      const started = new Set([
        ...(draft ? startedWorkflows(app.config) : []),
        ...(published ? startedWorkflows(app.publishedConfig) : [])
      ]);
      if (started.size === 0) continue;
      const config = draft ? app.config : app.publishedConfig;
      const caller: AppCaller = {
        name: app.name,
        title: config
          ? assetTitle(
              options.configAssets.kinds.kinds,
              APP_ASSET_KIND,
              app.name,
              config,
              undefined
            )
          : app.name,
        scope: app.scope
      };
      for (const workflow of started) {
        byWorkflow.set(workflow, [...(byWorkflow.get(workflow) ?? []), caller]);
      }
    }
    if (apps.length < PAGE) break;
    const last = apps.at(-1);
    if (!last || (afterName !== undefined && last.name <= afterName))
      throw new Error("App caller discovery cursor did not advance");
    afterName = last.name;
  }
  for (const callers of byWorkflow.values()) {
    callers.sort(
      (left, right) => left.title.localeCompare(right.title) || left.name.localeCompare(right.name)
    );
  }
  return byWorkflow;
}

/** The Workflows a revision of an App starts through its `workflow` actions. */
function startedWorkflows(config: JsonObject | null | undefined): string[] {
  return compiledActionsOf(config?.manifest).flatMap((action) =>
    action.kind === "workflow" ? [action.workflow] : []
  );
}
