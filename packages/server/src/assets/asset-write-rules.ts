import type { StoredAssets } from "./asset-reference-access";
export {
  assetKey,
  findIssuesOfChange,
  loadReferableAssets,
  type StoredAssets
} from "./asset-reference-access";
import {
  ASSET_RELEASE_SYNC_MAX_ITEMS,
  ASSET_SYNC_MAX_ITEMS
} from "@work-shape/catalyst-api-contract";
import {
  agentConfigSchema,
  findAgentUserSelectableModelIssues
} from "@work-shape/catalyst-config-schema";
import {
  ASSET_SYNC_CHANGE_TYPES,
  AppError,
  asCollaborationWorkspaceId,
  findNamespaceOfAssetName,
  hasAuthScope,
  isAppError,
  isJsonObject,
  moduleOffError,
  operationDenialError,
  unknownToJsonValue,
  type AccessResource,
  type ActorAccess,
  type AgentAvailability,
  type AgentConfig,
  type AssetScope,
  type AuditRecorder,
  type AuthenticatedIdentity,
  type CollaborationWorkspace,
  type ConfigAssetKind,
  type ConfigAssetRecord,
  type InitialAgentAvailability,
  type JsonObject,
  type Namespace,
  type OperationAuthorization,
  type RuntimeCallContext
} from "@work-shape/catalyst-core";
import { recordGovernanceAccess } from "../access/governance-actions";
import {
  findAgentToolValidation,
  type AgentToolValidationTargets,
  type AgentToolWarning
} from "../agent-tool-validation";
import { agentModelSettingValue } from "../asset-kinds/agent";
import {
  configValuesEqual,
  readDefinitionName,
  type AssetWriteSurface,
  type WorkflowAssetKind
} from "../asset-kinds/shared";
import type { AssetWorkflowOptions } from "../types";
import { decide, deleteDecision, errorIssues } from "./asset-access";
import {
  INVALID_ASSET_SET_MESSAGE,
  assetSetOf,
  definitionsOf,
  findAssetSetIssues,
  type AssetSet,
  type AssetSetIssue
} from "./asset-set";

/** The rules every write of an asset passes, whichever operation it arrives through. */

export async function loadStoredAssets(options: AssetWorkflowOptions): Promise<StoredAssets> {
  const [state, assets] = await Promise.all([
    options.configAssets.store.getConfigAssetState({ clientInstanceId: options.clientInstanceId }),
    options.configAssets.store.listActiveConfigAssets({
      clientInstanceId: options.clientInstanceId
    })
  ]);
  return { state, assets, set: assetSetOf(assets, state.defaultAgentName) };
}

/**
 * The stored assets of one kind, each with its published config where it has one. The list of
 * the stored assets carries only the drafts; the published configs are one more read.
 */
export async function withPublishedConfigs(
  options: AssetWorkflowOptions,
  assets: readonly ConfigAssetRecord[],
  kind: ConfigAssetKind
): Promise<ConfigAssetRecord[]> {
  const ofKind = assets.filter((asset) => asset.kind === kind);
  if (ofKind.length === 0) return ofKind;
  const published = new Map(
    (
      await options.configAssets.store.listPublishedConfigAssets({
        clientInstanceId: options.clientInstanceId,
        kind,
        names: ofKind.map((asset) => asset.name),
        limit: ofKind.length
      })
    ).map((asset) => [asset.name, asset.publishedConfig])
  );
  return ofKind.map((asset) => {
    const publishedConfig = published.get(asset.name);
    return publishedConfig === undefined ? asset : { ...asset, publishedConfig };
  });
}

/** The module whose switch turns changing assets in the interface on and off. */
const ASSET_MANAGEMENT_MODULE = "assetManagement";

/** The right of the release sync. Only a service principal holds it, on the instance. */
const RELEASE_ACTION = "assets.release";

/**
 * What a release is, all of it, decided here and nowhere else.
 *
 * A caller who holds `assets.release` on the instance and writes through `assets.sync` pushes
 * a release: the batch is what the operator's working copy says the instance holds. Inside
 * that call, and in no other, the holder is exempt from four things:
 *
 * 1. The item right. `assets.release` stands for the kind's write and delete right on each
 *    item. An explicit deny on the asset still refuses the item. (`itemWriteDecision`)
 * 2. The instance's editing limits: the module `assetManagement` being off,
 *    `allowAgentCreation`, `allowAgentDeletion`, `editableAgentFields` and
 *    `allowSkillEditing`. (`requireAssetManagementOn`, `authorizeInteractiveWrite`,
 *    `assertUpsertWithinLimits`, `assertDeleteWithinLimits`)
 * 3. The model settings right. `agent_models.manage` is not asked for the model settings a
 *    pushed agent carries. (`missingUpsertRightOf`, `assertUpsertWithinLimits`)
 * 4. The default agent. The holder names the instance default with the batch, which no
 *    other caller of the operation may. (`requireReleaseSync`)
 * 5. The Namespace. A release names none and reaches any asset of the instance; every other
 *    batch names the one Namespace or the one workspace it stays in. (`requireBatchScope`)
 *
 * A batch that names a workspace is never a release, whatever key it came with: what a
 * workspace owns is written by the rights on that workspace. (`accessOfSyncCredential`)
 *
 * And a release is handled in six ways no other write is:
 *
 * 6. A definition is written as it was sent. Nothing is adjusted on the way, so a setting the
 *    instance cannot run is refused and never dropped. (`preparedUpsert`)
 * 7. An agent it creates is available everywhere, and hidden only where the batch also
 *    deletes an agent that was available in chosen workspaces: that is a rename, and the new
 *    name must not reach more people than the old one did. Every other batch is made in no
 *    workspace, so its new agents start hidden. (`syncInitialAvailability`)
 * 8. A delete of an asset that is not there is no refusal. (`asset-sync.ts`)
 * 9. It may hold `ASSET_RELEASE_SYNC_MAX_ITEMS` items. (`maxSyncItems`)
 * 10. It reaches only the kinds a release carries. (`isReleasedKind`)
 * 11. Nothing picks its default agent. A batch of another caller makes the first agent of an
 *     instance its default and lets the last one take it away; a release leaves the default
 *     it names or the one that is stored, and is refused where that is no agent of the set.
 *     (`impliesDefaultChange`)
 *
 * Everything else binds the release holder as it binds everyone: the validation of the
 * definitions and of the set, the lists of a Namespace, the expected revisions, the policy and
 * the guardrails. On `put`, `delete` and `revert` the same holder is bound like any caller.
 * Every other caller is bound on every surface, whatever else that caller holds.
 */
export function isReleaseSync(access: ActorAccess, surface: AssetWriteSurface): boolean {
  // Asked without a resource, so only an entry at instance scope answers.
  return surface === "sync" && access.authorize(RELEASE_ACTION).allowed;
}

/** The scope of a key that was issued for release sync. */
const RELEASE_SCOPE = "config_assets:release";

/**
 * The access a sync or its check is decided with. A release takes both: the release right on
 * the principal and the release scope on the credential of this call. With a credential that
 * carries no release scope the principal holds no release right here, so the batch is an
 * ordinary writer's: it names its Namespace and is bound by everything `isReleaseSync` lists.
 * A batch that names a workspace is an ordinary writer's with any credential.
 */
export function accessOfSyncCredential(
  actor: AuthenticatedIdentity,
  access: ActorAccess,
  batch: { workspaceId?: string }
): ActorAccess {
  if (batch.workspaceId === undefined && hasAuthScope(actor, RELEASE_SCOPE)) return access;
  const authorize: ActorAccess["authorize"] = (action, resource) =>
    action === RELEASE_ACTION
      ? { allowed: false, reason: "no_grant" }
      : access.authorize(action, resource);
  return {
    scopeOf: (dimension) => access.scopeOf(dimension),
    authorize,
    authorizeTransfer: (action, resource) =>
      action === RELEASE_ACTION
        ? { allowed: false, reason: "no_grant" }
        : access.authorizeTransfer(action, resource),
    require(action, resource) {
      if (action === RELEASE_ACTION) {
        throw operationDenialError({ kind: "forbidden", action, reason: "no_grant" });
      }
      access.require(action, resource);
    },
    holdsGrantAt: (action, scopeKinds) =>
      action !== RELEASE_ACTION && access.holdsGrantAt(action, scopeKinds),
    denials: (action) => access.denials(action)
  };
}

/** Refuses what only a release may carry, naming the release right. */
export function requireReleaseSync(access: ActorAccess, surface: AssetWriteSurface): void {
  if (!isReleaseSync(access, surface)) {
    throw operationDenialError({ kind: "forbidden", action: RELEASE_ACTION, reason: "no_grant" });
  }
}

/**
 * Refuses a batch that names neither a Namespace nor a workspace, unless it is a release, and
 * one that names both.
 */
export function requireBatchScope(
  access: ActorAccess,
  batch: { namespace?: string; workspaceId?: string }
): void {
  if (batch.namespace !== undefined && batch.workspaceId !== undefined) {
    throw new AppError("VALIDATION_FAILED", "A batch names a Namespace or a workspace, not both", {
      reason: "invalid_scope"
    });
  }
  if (
    batch.namespace === undefined &&
    batch.workspaceId === undefined &&
    !isReleaseSync(access, "sync")
  ) {
    throw new AppError(
      "VALIDATION_FAILED",
      "A batch names the Namespace or the workspace it belongs to"
    );
  }
}

/**
 * Refuses an owner that is no workspace of this instance, before the store is asked to write
 * an asset for it. Whether the caller may write there is the right's, decided before.
 */
export async function requireOwnerWorkspace(
  options: AssetWorkflowOptions,
  workspaceId: string | undefined
): Promise<void> {
  if (workspaceId === undefined) return;
  const workspace = await options.stores.workspaces.getWorkspace(
    options.clientInstanceId,
    asCollaborationWorkspaceId(workspaceId)
  );
  if (!workspace) {
    throw new AppError(
      "VALIDATION_FAILED",
      `'${workspaceId}' is no workspace of this client instance`,
      { reason: "workspace_not_found" }
    );
  }
}

/** Whether the first and the last agent of an instance move its default with the batch. */
export function impliesDefaultChange(access: ActorAccess): boolean {
  return !isReleaseSync(access, "sync");
}

/** What a save writes of what its caller sent: adjusted by the kind, or untouched in a release. */
export function preparedUpsert(
  access: ActorAccess,
  surface: AssetWriteSurface,
  kind: WorkflowAssetKind,
  input: Parameters<WorkflowAssetKind["prepareInteractiveUpsert"]>[0]
): Record<string, unknown> {
  return isReleaseSync(access, surface) ? input.next : kind.prepareInteractiveUpsert(input);
}

/**
 * Where the agents a batch creates start. Nothing leaves it to the store's default. A batch
 * that gives the instance its first default agent makes its agents available everywhere,
 * because the default must be.
 */
export function syncInitialAvailability(
  access: ActorAccess,
  setsFirstDefault: boolean
): { initialAgentAvailability: InitialAgentAvailability } {
  if (isReleaseSync(access, "sync")) {
    return { initialAgentAvailability: "selected_when_replacing_selected" };
  }
  return { initialAgentAvailability: setsFirstDefault ? "all" : "hidden" };
}

/** How many items one batch of this caller may hold. */
export function maxSyncItems(access: ActorAccess): number {
  return isReleaseSync(access, "sync") ? ASSET_RELEASE_SYNC_MAX_ITEMS : ASSET_SYNC_MAX_ITEMS;
}

/**
 * Whether a release carries the kind. A kind that is not marked so was never written by a
 * release, so the exemptions above do not reach it until it is.
 */
export function isReleasedKind(kind: WorkflowAssetKind): boolean {
  return kind.inRelease === true;
}

/** An agent no workspace shows: it has no availability, or one that selects nothing. */
export function isHiddenEverywhere(availability: AgentAvailability | undefined): boolean {
  return (
    !availability ||
    (availability.mode === "selected" &&
      !availability.personalWorkspaces &&
      availability.collaborationWorkspaceIds.length === 0)
  );
}

/**
 * The caller's right to write or delete one asset: the kind's own right on it, or the release
 * holder's inside a sync. A deny on the asset refuses the release holder too.
 */
export function itemWriteDecision(
  access: ActorAccess,
  surface: AssetWriteSurface,
  target: { kind: WorkflowAssetKind; resource: AccessResource },
  type: (typeof ASSET_SYNC_CHANGE_TYPES)[number]
): OperationAuthorization {
  const { actions } = target.kind;
  const right =
    type === "delete"
      ? deleteDecision(access, target)
      : decide(access, actions.write, target.resource);
  if (right.allowed || !isReleaseSync(access, surface)) {
    return right;
  }
  // What the delete right may not get around, the release right may not either.
  const deniable =
    type === "delete" ? [actions.delete, actions.read, actions.write] : [actions.write];
  for (const action of deniable) {
    const decision = access.authorize(action, target.resource);
    if (!decision.allowed && decision.reason === "denied") {
      return { allowed: false, action, reason: "denied" };
    }
  }
  return { allowed: true };
}

/** Refuses a call that names an asset kind of a module that is off, as a call of that module. */
export function requireAssetKindModuleOn(
  modules: AssetWorkflowOptions["modules"],
  kind: string
): void {
  const module = modules.offModuleOf("kind", kind);
  if (module !== undefined) {
    throw moduleOffError(module);
  }
}

/** Refuses a write where changing assets is off, as a call of an operation of the module. */
export function requireAssetManagementOn(
  options: Pick<AssetWorkflowOptions, "modules">,
  access: ActorAccess,
  surface: AssetWriteSurface
): void {
  if (!options.modules.isEnabled(ASSET_MANAGEMENT_MODULE) && !isReleaseSync(access, surface)) {
    throw moduleOffError(ASSET_MANAGEMENT_MODULE);
  }
}

/** Records the write and refuses it where the instance has interactive editing off. */
export async function authorizeInteractiveWrite(
  options: AssetWorkflowOptions,
  user: AuthenticatedIdentity,
  context: Pick<RuntimeCallContext, "correlationId">,
  /** The recorder of the Operation Run, where the write is one. */
  audit: AuditRecorder = options.auditRecorder,
  /** The answer of `isReleaseSync`. A caller that passes none is bound. */
  releaseSync = false
): Promise<void> {
  await recordGovernanceAccess({
    options: { auditRecorder: audit },
    user,
    context,
    auditType: "governance.config_assets_write_authorized"
  });
  requireInteractiveEditingOn(options, releaseSync);
}

/** Refuses everyone but a release where the instance has interactive editing off. */
export function requireInteractiveEditingOn(
  options: Pick<AssetWorkflowOptions, "modules">,
  releaseSync: boolean
): void {
  if (!releaseSync && !options.modules.isEnabled(ASSET_MANAGEMENT_MODULE)) {
    throw new AppError("FORBIDDEN", "Interactive agent configuration is disabled");
  }
}

/** The kind's editing policy for a save, asked of the validated definition. */
export function assertUpsertWithinLimits(
  access: ActorAccess,
  surface: AssetWriteSurface,
  kind: WorkflowAssetKind,
  input: Omit<
    Parameters<WorkflowAssetKind["assertInteractiveUpsertAllowed"]>[0],
    "access" | "surface"
  >
): void {
  if (!isReleaseSync(access, surface)) {
    kind.assertInteractiveUpsertAllowed({ access, surface, ...input });
  }
}

/** The kind's editing policy for a delete. */
export function assertDeleteWithinLimits(
  access: ActorAccess,
  surface: AssetWriteSurface,
  kind: WorkflowAssetKind
): void {
  if (!isReleaseSync(access, surface)) {
    kind.assertInteractiveDeleteAllowed({ surface });
  }
}

/** The right a save needs beside the kind's write right and its caller lacks. */
export function missingUpsertRightOf(
  access: ActorAccess,
  surface: AssetWriteSurface,
  kind: WorkflowAssetKind,
  input: Omit<Parameters<WorkflowAssetKind["missingUpsertRight"]>[0], "access">
): string | undefined {
  return isReleaseSync(access, surface) ? undefined : kind.missingUpsertRight({ access, ...input });
}

/** Throws an editing-policy refusal before confirmation, or returns a further missing right. */
export function assertUpsertPolicyAndMissingRight(
  access: ActorAccess,
  surface: AssetWriteSurface,
  kind: WorkflowAssetKind,
  input: Omit<Parameters<WorkflowAssetKind["missingUpsertRight"]>[0], "access">
): string | undefined {
  const action = missingUpsertRightOf(access, surface, kind, input);
  if (action !== undefined) return action;
  const parsed = kind.read([input.next]);
  const write = { ...input, next: parsed.accepted[0] ?? input.next };
  // Invalid shapes are reported by validation; a valid definition also passes edit policy.
  if (parsed.refused.length === 0) assertUpsertWithinLimits(access, surface, kind, write);
  return undefined;
}

// The first asset of a kind with an instance default becomes it and the last one takes it
// away. Either changes the default, which no Namespace or asset grant opens.
export function requireInstanceDefaultChange(
  access: ActorAccess,
  kind: WorkflowAssetKind,
  changesDefault: boolean
): void {
  if (changesDefault) {
    access.require(kind.actions.write);
  }
}

/**
 * Whether a write of the first asset of a kind with an instance default makes it the default.
 * Only an asset the instance owns becomes it: a workspace's agent is never the default.
 */
export function setsInitialDefault(
  set: AssetSet,
  kind: WorkflowAssetKind,
  scope: AssetScope
): boolean {
  return scope.kind === "instance" && isFirstOfDefaultKind(set, kind);
}

/**
 * Refuses a workspace's asset as the first of a kind with an instance default. An instance
 * that holds such an asset has a default, which only an asset of the instance can be, so the
 * first one is made for the whole instance.
 */
export function requireInstanceFirstForDefault(
  set: AssetSet,
  kind: WorkflowAssetKind,
  scope: AssetScope
): void {
  if (scope.kind === "workspace" && isFirstOfDefaultKind(set, kind)) {
    throw new AppError(
      "VALIDATION_FAILED",
      `The instance has no ${kind.kind} yet. Its first ${kind.kind} becomes its default, which only a ${kind.kind} of the whole instance can be`,
      { reason: "default_owned_by_workspace" }
    );
  }
}

function isFirstOfDefaultKind(set: AssetSet, kind: WorkflowAssetKind): boolean {
  return (
    kind.holdsInstanceDefault &&
    definitionsOf(set, kind.kind).length === 0 &&
    set.defaultAgentName === undefined
  );
}

export function clearsLastDefault(set: AssetSet, kind: WorkflowAssetKind, name: string): boolean {
  return (
    kind.holdsInstanceDefault &&
    definitionsOf(set, kind.kind).length === 1 &&
    set.defaultAgentName === name
  );
}

/**
 * The agents a write adds or changes, read once more with the agent schema so the rules below
 * see them typed. An agent the write leaves as it is stored is not among them.
 */
function changedAgents(
  stored: AssetSet,
  validated: AssetSet
): Array<{
  agent: AgentConfig;
  stored: unknown;
}> {
  const storedByName = new Map(
    definitionsOf(stored, "agent").map((definition) => [readDefinitionName(definition), definition])
  );
  return definitionsOf(validated, "agent").flatMap((definition) => {
    const before = storedByName.get(readDefinitionName(definition));
    if (configValuesEqual(before, toJsonObject(definition))) return [];
    return [{ agent: agentConfigSchema.parse(definition), stored: before }];
  });
}

/** One agent a write adds or changes, with the rule that refuses it. */
export interface ChangedAgentRefusal {
  agentName: string;
  error: AppError;
}

/**
 * Checks submitted agents' tool references and changed agents' models and editing limits.
 * Returns refusals, callability warnings and scope records for the kind's editing policy.
 * These limits bind every writer; null allows everything and an empty list nothing.
 */
export async function findChangedAgentRefusals(
  options: AssetWorkflowOptions,
  access: ActorAccess,
  stored: AssetSet,
  validated: AssetSet,
  toolTargets: AgentToolValidationTargets
): Promise<{
  lists: AgentLists;
  modelIssues: string[];
  refusals: ChangedAgentRefusal[];
  warnings: AgentToolWarning[];
}> {
  const changed = changedAgents(stored, validated);
  const { refusals, warnings } = await findAgentToolValidation(options, validated, toolTargets);
  // An agent's list of user-selectable models must name eligible bindings whenever it is
  // written. Unchanged lists are not re-checked, so a binding that later disappears or stops
  // being agent-selectable never blocks other edits; such ids are ignored at read time.
  const eligibleIds = options.configAssets.validationRefs.modelBindingIds;
  const modelIssues: string[] = [];
  for (const entry of changed) {
    if (
      configValuesEqual(
        agentModelSettingValue(entry.stored, "userSelectableModelBindingIds"),
        agentModelSettingValue(entry.agent, "userSelectableModelBindingIds")
      )
    ) {
      continue;
    }
    const issues = findAgentUserSelectableModelIssues(entry.agent, eligibleIds);
    if (issues.length > 0) {
      modelIssues.push(...issues);
      refusals.push({ agentName: entry.agent.name, error: invalidAssetSet(issues) });
    }
  }
  // A write has one owner: the workspace whose build limits bind the agents it owns.
  const lists = await loadAgentLists(options, toolTargets.scope.workspaceId);
  for (const { agent } of changed) {
    const namespace = findNamespaceOfAssetName(lists.namespaces, agent.name);
    const error =
      (namespace && buildLimitRefusal(access, namespaceLimits(namespace), agent)) ??
      (lists.workspace && buildLimitRefusal(access, workspaceLimits(lists.workspace), agent));
    if (error) refusals.push({ agentName: agent.name, error });
  }
  return { lists, modelIssues, refusals, warnings };
}

/**
 * The lists that bind the agents of one owner: the Namespaces', until NS-RETIRE, and the build
 * limits of the workspace that owns them.
 */
export interface AgentLists {
  namespaces: readonly Namespace[];
  workspace?: CollaborationWorkspace;
}

export async function loadAgentLists(
  options: Pick<AssetWorkflowOptions, "stores" | "clientInstanceId">,
  workspaceId: string | undefined
): Promise<AgentLists> {
  const { clientInstanceId } = options;
  // The Namespaces without their counts: a write reads the prefixes and the lists only.
  const [namespaces, workspace] = await Promise.all([
    options.stores.access.listNamespaceRecords({ clientInstanceId }),
    workspaceId === undefined
      ? undefined
      : options.stores.workspaces.getWorkspace(
          clientInstanceId,
          asCollaborationWorkspaceId(workspaceId)
        )
  ]);
  return { namespaces, ...(workspace ? { workspace } : {}) };
}

/**
 * Whether a list names the model bindings the agent may use: the operator's choice of models
 * for it, so its writer picks among them without the right to manage models.
 */
export function listsModelBindings(lists: AgentLists, agentName: string): boolean {
  return (
    findNamespaceOfAssetName(lists.namespaces, agentName)?.allowedModelBindingIds !== undefined ||
    lists.workspace?.allowedModelBindingIds !== undefined
  );
}

/** Lists that bind an agent, with the place a refusal names. */
interface BuildLimits extends Pick<Namespace, "allowedToolNames" | "allowedModelBindingIds"> {
  /** "Namespace 'kai-'" or "workspace 'Kai Spezis'". */
  place: string;
  details: { namespace: string } | { workspaceId: string; workspace: string };
}

function namespaceLimits(namespace: Namespace): BuildLimits {
  return {
    ...namespace,
    place: `Namespace '${namespace.prefix}'`,
    details: { namespace: namespace.prefix }
  };
}

function workspaceLimits(workspace: CollaborationWorkspace): BuildLimits {
  return {
    ...workspace,
    place: `workspace '${workspace.name}'`,
    details: { workspaceId: workspace.id, workspace: workspace.name }
  };
}

/** Throws the first refusal of `findChangedAgentRefusals`: the model issues before the lists. */
export async function assertChangedAgentsAllowed(
  options: AssetWorkflowOptions,
  access: ActorAccess,
  stored: AssetSet,
  validated: AssetSet,
  toolTargets: AgentToolValidationTargets
): Promise<{ lists: AgentLists; warnings: AgentToolWarning[] }> {
  const found = await findChangedAgentRefusals(options, access, stored, validated, toolTargets);
  if (found.modelIssues.length > 0) {
    throw invalidAssetSet(found.modelIssues);
  }
  const [refusal] = found.refusals;
  if (refusal) {
    throw refusal.error;
  }
  return found;
}

function invalidAssetSet(issues: readonly string[]): AppError {
  return new AppError("VALIDATION_FAILED", INVALID_ASSET_SET_MESSAGE, {
    issues: issues.map((message) => ({ message }))
  });
}

function buildLimitRefusal(
  access: ActorAccess,
  limits: BuildLimits,
  agent: AgentConfig
): AppError | undefined {
  const allowedToolNames = limits.allowedToolNames;
  const toolName =
    allowedToolNames && agent.toolNames.find((name) => !allowedToolNames.includes(name));
  if (toolName !== undefined) {
    return new AppError("FORBIDDEN", `Tool '${toolName}' is not allowed in ${limits.place}`, {
      reason: "tool_not_allowed",
      toolName,
      ...limits.details
    });
  }
  const allowedModelBindingIds = limits.allowedModelBindingIds;
  const modelBindingId =
    allowedModelBindingIds &&
    [
      ...(agent.modelBindingId === undefined ? [] : [agent.modelBindingId]),
      ...(agent.userSelectableModelBindingIds ?? [])
    ].find((id) => !allowedModelBindingIds.includes(id));
  if (modelBindingId !== undefined) {
    return new AppError(
      "FORBIDDEN",
      `Model binding '${modelBindingId}' is not allowed in ${limits.place}`,
      { reason: "model_not_allowed", modelBindingId, ...limits.details }
    );
  }
  // Without a binding the agent runs the provider it names or the instance default, which
  // no list can name. Only the right that manages models may leave the list that way.
  if (
    allowedModelBindingIds &&
    agent.modelBindingId === undefined &&
    !access.authorize("agent_models.manage").allowed
  ) {
    return new AppError(
      "FORBIDDEN",
      `An agent in ${limits.place} must select a model binding allowed there`,
      { reason: "model_binding_required", ...limits.details }
    );
  }
  return undefined;
}

export function requireMatchingConfigName(config: unknown, expectedName: string): void {
  if (readDefinitionName(config) !== expectedName) {
    throw new AppError("VALIDATION_FAILED", "Config asset name must match the request path");
  }
}

export function toJsonObject(value: unknown): JsonObject {
  const json = unknownToJsonValue(value);
  if (!isJsonObject(json)) {
    throw new AppError("VALIDATION_FAILED", "Config asset must be a JSON object");
  }
  return json;
}

/** What the kind refuses a write of the stored asset for, whatever the write says. */
export function storedWritableIssues(
  kind: WorkflowAssetKind,
  current: unknown
): AssetSetIssue[] | undefined {
  if (current === undefined) return undefined;
  try {
    kind.assertStoredWritable?.({ current });
    return undefined;
  } catch (error) {
    if (isAppError(error)) return errorIssues(error);
    throw error;
  }
}

/**
 * What a write of a definition would be refused for by the instance's own rules, asked once
 * the definitions themselves hold. `withinOwners` is the writer's rule on what the definition
 * names across owners; `scopedWrite` is the kind's check of the write against the stores, as
 * a put asks it: a Workflow's child and dataset contracts.
 */
export async function writeIssuesOf(
  options: AssetWorkflowOptions,
  access: ActorAccess,
  stored: AssetSet,
  found: ReturnType<typeof findAssetSetIssues>,
  withinOwners: () => Promise<void>,
  toolTargets: AgentToolValidationTargets,
  scopedWrite?: () => Promise<void>
): Promise<{ issues: AssetSetIssue[]; warnings: AgentToolWarning[] }> {
  try {
    const issues = found.validateWrite(stored);
    if (issues.length > 0) return { issues, warnings: [] };
    await withinOwners();
    await scopedWrite?.();
    const { refusals, warnings } = await findChangedAgentRefusals(
      options,
      access,
      stored,
      found.accepted,
      toolTargets
    );
    return { issues: refusals.flatMap(({ error }) => errorIssues(error)), warnings };
  } catch (error) {
    if (isAppError(error) && error.code === "VALIDATION_FAILED") {
      return { issues: errorIssues(error), warnings: [] };
    }
    throw error;
  }
}
