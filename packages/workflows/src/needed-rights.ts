import {
  CONNECTION_ACTIONS,
  CONNECTION_ASSET_KIND,
  DATA_STORE_LOAD_CHANGE_RIGHT,
  DATA_STORE_OPERATION_PREFIX,
  DATA_STORE_OPERATION_RIGHTS,
  WORKFLOW_ACTIONS,
  WORKFLOW_ASSET_KIND,
  workflowStartOperationName,
  type AssetScope,
  type ClientInstanceId,
  type ConfigAssetStore,
  type OperationRegistry,
  type JsonValue,
  type OperationDefinition,
  type WorkflowInputMapping,
  type WorkflowManifest,
  type WorkflowNeededRight,
  type WorkflowRightNeededFor
} from "@work-shape/catalyst-core";
import { indexWorkflowSteps } from "./definition";

/** What the derivation reads of an operation: the right it asks and what it is asked on. */
export type NeededRightOperation = Pick<
  OperationDefinition,
  "action" | "resource" | "rightNeededAtPublish"
>;

/** What the derivation is told beside the definition. */
export interface WorkflowNeededRightsContext {
  /** The operations the definition names that exist, by name (`workflowOperationNames`). */
  operations: ReadonlyMap<string, NeededRightOperation>;
  /** The identity and owner of each child Workflow that has an asset, by its name. */
  workflowAssets: ReadonlyMap<string, { id: string; scope: AssetScope }>;
}

/**
 * The names of the operations a run of the definition may call: those of its operation
 * steps, and the tools of its agent steps.
 */
export function workflowOperationNames(
  manifest: Pick<WorkflowManifest, "steps" | "tools">
): string[] {
  const names = new Set<string>();
  let agent = false;
  for (const { step } of indexWorkflowSteps(manifest).values()) {
    if (step.type === "operation") names.add(step.operation);
    if (step.type === "agent") agent = true;
  }
  if (agent) for (const tool of manifest.tools ?? []) names.add(tool);
  return [...names];
}

/**
 * The rights the account of a Workflow (`runAs`) needs, derived from its definition. The one
 * list both the publish check and the publish screen read, so a refusal and the screen never
 * name different rights:
 * - a `workflow` step needs `workflow.use` on the child, and the publish is refused without it;
 * - a step or an agent tool that calls an operation needs the right the operation names, on
 *   what it names, and the publish is refused without it where the operation says so
 *   (`rightNeededAtPublish`, such as `mail_sender.use` of `mail.send`); a Connection's operation needs `connection.use` on the Connection, and a
 *   Data Store's `load` needs `data_store.insert`, and `data_store.execute` as well where its
 *   mapping replaces rows or updates them on a conflict, or leaves that to a reference.
 * An operation that does not exist is left out: the definition check refuses it.
 */
export function workflowNeededRights(
  manifest: Pick<WorkflowManifest, "steps" | "tools">,
  context: WorkflowNeededRightsContext
): WorkflowNeededRight[] {
  const found = new Map<string, WorkflowNeededRight>();
  const add = (
    action: string,
    asset: WorkflowNeededRight["asset"],
    step: string,
    neededFor: WorkflowRightNeededFor
  ) => {
    const key = `${action}\u0000${asset.kind}\u0000${asset.assetId ?? asset.name}`;
    const known = found.get(key);
    if (!known) {
      found.set(key, { action, asset, steps: [step], neededFor });
      return;
    }
    if (!known.steps.includes(step)) known.steps.push(step);
    if (neededFor === "publish") known.neededFor = "publish";
  };
  const addOperation = (name: string, input: WorkflowInputMapping | undefined, step: string) => {
    const operation = context.operations.get(name);
    if (!operation) return;
    for (const right of operationRights(name, operation, input))
      add(right.action, right.asset, step, operation.rightNeededAtPublish ? "publish" : "run");
  };
  let agentStep: string | undefined;
  for (const { step } of indexWorkflowSteps(manifest).values()) {
    if (step.type === "workflow") {
      const asset = context.workflowAssets.get(step.workflow);
      add(
        WORKFLOW_ACTIONS.use,
        {
          kind: WORKFLOW_ASSET_KIND,
          name: step.workflow,
          ...(asset === undefined ? {} : { assetId: asset.id }),
          ...(asset?.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {})
        },
        step.id,
        "publish"
      );
    }
    if (step.type === "operation") addOperation(step.operation, step.input, step.id);
    if (step.type === "agent") agentStep ??= step.id;
  }
  if (agentStep !== undefined)
    for (const tool of manifest.tools ?? []) addOperation(tool, undefined, agentStep);
  return [...found.values()];
}

/** The rights one call of an operation asks, as far as the mapping tells before the run. */
function operationRights(
  name: string,
  operation: NeededRightOperation,
  input: WorkflowInputMapping | undefined
): { action: string; asset: WorkflowNeededRight["asset"] }[] {
  const resource = resourceOf(operation, input);
  if (!resource?.name) return [];
  const asset = {
    kind: resource.kind,
    name: resource.name,
    ...(resource.assetId === undefined ? {} : { assetId: resource.assetId }),
    ...(resource.workspaceId === undefined ? {} : { workspaceId: resource.workspaceId })
  };
  if (operation.action !== null) return [{ action: operation.action, asset }];
  // An operation with a check of its own can still require a grant on the named asset.
  if (resource.kind === CONNECTION_ASSET_KIND) return [{ action: CONNECTION_ACTIONS.use, asset }];
  if (resource.kind === WORKFLOW_ASSET_KIND && name === workflowStartOperationName(resource.name))
    return [{ action: WORKFLOW_ACTIONS.use, asset }];
  if (name.startsWith(DATA_STORE_OPERATION_PREFIX) && name.endsWith(".load")) {
    return [
      { action: DATA_STORE_OPERATION_RIGHTS.load, asset },
      ...(loadChangesRows(input) ? [{ action: DATA_STORE_LOAD_CHANGE_RIGHT, asset }] : [])
    ];
  }
  return [];
}

/**
 * A load replaces or updates stored rows, or a reference or a text joined from parts decides
 * that when it runs.
 */
function loadChangesRows(input: WorkflowInputMapping | undefined): boolean {
  if (input === undefined) return true;
  const replace = input.replace;
  const onConflict = input.onConflict;
  const replaces = replace !== undefined && replace.value !== null;
  const updates =
    onConflict !== undefined && (onConflict.value === undefined || onConflict.value === "update");
  return replaces || updates;
}

function resourceOf(operation: NeededRightOperation, input: WorkflowInputMapping | undefined) {
  const literal: Record<string, JsonValue> = {};
  for (const [field, value] of Object.entries(input ?? {}))
    if (value.value !== undefined) literal[field] = value.value;
  try {
    return operation.resource(literal);
  } catch {
    // What the operation needs on a field a reference fills is known only when it runs.
    return undefined;
  }
}

/** Resolve the named assets and operations once, for publishing and the draft's ceiling. */
export async function resolveWorkflowNeededRights(
  options: {
    clientInstanceId: ClientInstanceId;
    configAssets: Pick<ConfigAssetStore, "getConfigAsset">;
    registry?: () => Pick<OperationRegistry, "resolveMany"> | undefined;
  },
  manifest: Pick<WorkflowManifest, "steps" | "tools">
): Promise<WorkflowNeededRight[]> {
  const names = workflowOperationNames(manifest);
  const operations = (await options.registry?.()?.resolveMany(names)) ?? new Map();
  const workflowAssets = new Map<string, { id: string; scope: AssetScope }>();
  for (const { step } of indexWorkflowSteps(manifest).values()) {
    if (step.type !== "workflow" || workflowAssets.has(step.workflow)) continue;
    const asset = await options.configAssets.getConfigAsset({
      clientInstanceId: options.clientInstanceId,
      kind: WORKFLOW_ASSET_KIND,
      name: step.workflow
    });
    if (asset) workflowAssets.set(step.workflow, { id: asset.id, scope: asset.scope });
  }
  // Operation resources may name an asset without carrying its id. Grants always name the id.
  const rights = workflowNeededRights(manifest, { operations, workflowAssets });
  for (const right of rights) {
    if (right.asset.assetId !== undefined) continue;
    const asset = await options.configAssets.getConfigAsset({
      clientInstanceId: options.clientInstanceId,
      kind: right.asset.kind,
      name: right.asset.name
    });
    if (asset?.status === "active") {
      right.asset.assetId = asset.id;
      if (asset.scope.kind === "workspace") right.asset.workspaceId = asset.scope.workspaceId;
    }
  }
  return rights;
}
