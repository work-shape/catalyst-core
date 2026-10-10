import {
  AppError,
  assetScopesEqual,
  findNamespaceOfAssetName,
  isJsonObject,
  moduleOffError,
  unknownToJsonValue,
  type AccessResource,
  type ActorAccess,
  type AgentConfig,
  type AssetScope,
  type AuditRecorder,
  type AuthenticatedIdentity,
  type ConfigAssetKind,
  type ConfigAssetMutation,
  type ConfigAssetRecord,
  type ConfigAssetState,
  type InitialAgentAvailability,
  type JsonObject,
  type Namespace,
  type OperationAuthorization,
  type OperationOrigin,
  type RuntimeCallContext
} from "@vivd-catalyst/core";
import {
  agentConfigSchema,
  findAgentUserSelectableModelIssues
} from "@vivd-catalyst/config-schema";
import { agentModelSettingValue } from "./asset-kinds/agent";
import {
  configValuesEqual,
  readDefinitionName,
  type WorkflowAssetKind
} from "./asset-kinds/shared";
import { accessResource, decide, deleteDecision } from "./asset-access";
import {
  INVALID_ASSET_SET_MESSAGE,
  assetSetOf,
  definitionsOf,
  findAssetSetIssues,
  type AssetSet,
  type AssetSetIssue
} from "./asset-set";
import { recordGovernanceAccess } from "./governance-actions";
import type { ChatServerOptions } from "./types";

/** The rules every write of an asset passes, whichever operation it arrives through. */

export interface StoredAssets {
  state: ConfigAssetState;
  assets: ConfigAssetRecord[];
  set: AssetSet;
}

export async function loadStoredAssets(options: ChatServerOptions): Promise<StoredAssets> {
  const [state, assets] = await Promise.all([
    options.configAssets.store.getConfigAssetState({ clientInstanceId: options.clientInstanceId }),
    options.configAssets.store.listActiveConfigAssets({
      clientInstanceId: options.clientInstanceId
    })
  ]);
  return { state, assets, set: assetSetOf(assets, state.defaultAgentName) };
}

/** What a refused change is told of an asset its caller may not read: that there is one. */
const UNREAD_ASSET_ISSUE = "The change would break an asset the caller may not read";

/** The stored assets as one caller's change is checked against them. */
interface ReferableAssets {
  /**
   * What a definition of the caller is resolved against: the assets the caller may read, the
   * unread ones beside the written asset in its Namespace, and the instance's default.
   */
  set: AssetSet;
  /** The assets the caller may read, and no other. */
  readable: AssetSet;
  /** Nothing was left out of `set`: it is the stored set itself. */
  complete: boolean;
}

/**
 * What a caller's definition is resolved against: the stored assets the caller may read, and
 * those beside the written asset in its Namespace, which it may refer to whoever writes it.
 * A name outside every Namespace has no such neighbours. Every other asset is left out, so a
 * reference to it reads as a reference to nothing. The instance's default stays in, because
 * the rule that an instance with agents has one is about the set and not about the change.
 */
export async function loadReferableAssets(
  options: ChatServerOptions,
  access: ActorAccess,
  stored: StoredAssets,
  /** The owner of what is written, and a name of it, or the prefix of its Namespace. */
  written: { scope: AssetScope; name: string | undefined }
): Promise<ReferableAssets> {
  const isReadable = (asset: ConfigAssetRecord) => {
    const kind = options.configAssets.kinds.get(asset.kind);
    return (
      // No registered kind reads the definition, so no check resolves anything against it.
      kind === undefined ||
      access.authorize(
        kind.actions.read,
        accessResource(asset.kind, asset.name, asset.scope, asset.id)
      ).allowed
    );
  };
  const unread = new Set(stored.assets.filter((asset) => !isReadable(asset)));
  if (unread.size === 0) {
    return { set: stored.set, readable: stored.set, complete: true };
  }
  const namespaces =
    written.scope.kind === "instance"
      ? await options.stores.access.listNamespaceRecords({
          clientInstanceId: options.clientInstanceId
        })
      : [];
  const namespaceOf = (name: string) => findNamespaceOfAssetName(namespaces, name)?.prefix;
  const namespace = written.name === undefined ? undefined : namespaceOf(written.name);
  const isNeighbour = (asset: ConfigAssetRecord) =>
    namespace !== undefined &&
    assetScopesEqual(asset.scope, written.scope) &&
    namespaceOf(asset.name) === namespace;
  const isInstanceDefault = (asset: ConfigAssetRecord) =>
    asset.name === stored.state.defaultAgentName &&
    options.configAssets.kinds.get(asset.kind)?.holdsInstanceDefault === true;
  const { defaultAgentName } = stored.state;
  return {
    set: assetSetOf(
      stored.assets.filter(
        (asset) => !unread.has(asset) || isNeighbour(asset) || isInstanceDefault(asset)
      ),
      defaultAgentName
    ),
    readable: assetSetOf(
      stored.assets.filter((asset) => !unread.has(asset)),
      defaultAgentName
    ),
    complete: false
  };
}

/**
 * What a change is refused for, as its caller may be told. `change` makes of a set what the
 * change would leave of it.
 *
 * The change is read against the view, which leaves assets out. The view has issues of its
 * own, because what it keeps may refer to what it leaves out: those are not the change's and
 * are not told, and a reference the changed definition carried already is among them, so a
 * write is never refused for a reference it only keeps. An issue that arises only because of
 * an asset the caller may not read, in the view or in the stored set as a whole, is told as
 * one sentence that names nothing.
 */
export function findIssuesOfChange(
  kinds: readonly WorkflowAssetKind[],
  stored: AssetSet,
  view: ReferableAssets,
  change: (set: AssetSet) => AssetSet,
  /** The keys of the definitions the change writes. */
  changed: ReadonlySet<string>
): AssetSetIssue[] {
  const key = (issue: AssetSetIssue) => JSON.stringify([issue.message, issue.path?.map(String)]);
  const keysOf = (issues: readonly AssetSetIssue[]) => new Set(issues.map(key));
  const before = new Map<string, number>();
  for (const issue of findAssetSetIssues(kinds, view.set).issues) {
    before.set(key(issue), (before.get(key(issue)) ?? 0) + 1);
  }
  const ofChange = findAssetSetIssues(kinds, change(view.set)).issues.filter((issue) => {
    if (issue.assetKind !== undefined && issue.assetName !== undefined) {
      // An issue of one definition is the change's when the change writes that definition.
      return changed.has(assetKey(issue.assetKind, issue.assetName));
    }
    const count = before.get(key(issue)) ?? 0;
    before.set(key(issue), count - 1);
    return count <= 0;
  });
  // What the change is refused for with nothing but readable assets around it is the
  // caller's to hear. Every other issue is there because of an asset the caller may not read.
  const amongReadable = keysOf(findAssetSetIssues(kinds, change(view.readable)).issues);
  const told = ofChange.filter((issue) => amongReadable.has(key(issue)));
  const toldKeys = keysOf(told);
  const untold =
    told.length < ofChange.length ||
    findAssetSetIssues(kinds, change(stored)).issues.some((issue) => !toldKeys.has(key(issue)));
  return untold ? [...told, { message: UNREAD_ASSET_ISSUE }] : told;
}

/** The operation a write of an asset arrives through. */
export type AssetWriteSurface = "put" | "delete" | "revert" | "sync";

/** The module whose switch turns changing assets in the interface on and off. */
const ASSET_MANAGEMENT_MODULE = "assetManagement";

/** The right of the release sync. Only a service principal holds it, on the instance. */
const RELEASE_ACTION = "assets.release";

/**
 * The exemptions of the release holder, all of them, decided here and nowhere else.
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
 * 4. The default agent. The first agent of the instance becomes its default and the last one
 *    takes it away without the kind's write right on the instance.
 *    (`mayChangeInstanceDefault`)
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

/**
 * The caller's right to write or delete one asset: the kind's own right on it, or the release
 * holder's inside a sync. A deny on the asset refuses the release holder too.
 */
export function itemWriteDecision(
  access: ActorAccess,
  surface: AssetWriteSurface,
  target: { kind: WorkflowAssetKind; resource: AccessResource },
  type: "put" | "delete"
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

/** Refuses a write where changing assets is off, as a call of an operation of the module. */
export function requireAssetManagementOn(
  options: Pick<ChatServerOptions, "modules">,
  access: ActorAccess,
  surface: AssetWriteSurface
): void {
  if (!options.modules.isEnabled(ASSET_MANAGEMENT_MODULE) && !isReleaseSync(access, surface)) {
    throw moduleOffError(ASSET_MANAGEMENT_MODULE);
  }
}

/** Records the write and refuses it where the instance has interactive editing off. */
export async function authorizeInteractiveWrite(
  options: ChatServerOptions,
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
  if (!releaseSync && !options.modules.isEnabled(ASSET_MANAGEMENT_MODULE)) {
    throw new AppError("FORBIDDEN", "Interactive agent configuration is disabled");
  }
}

/** The kind's editing policy for a save, asked of the validated definition. */
export function assertUpsertWithinLimits(
  access: ActorAccess,
  surface: AssetWriteSurface,
  kind: WorkflowAssetKind,
  input: Omit<Parameters<WorkflowAssetKind["assertInteractiveUpsertAllowed"]>[0], "access">
): void {
  if (!isReleaseSync(access, surface)) {
    kind.assertInteractiveUpsertAllowed({ access, ...input });
  }
}

/** The kind's editing policy for a delete. */
export function assertDeleteWithinLimits(
  access: ActorAccess,
  surface: AssetWriteSurface,
  kind: WorkflowAssetKind
): void {
  if (!isReleaseSync(access, surface)) {
    kind.assertInteractiveDeleteAllowed();
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

// The first asset of a kind with an instance default becomes it and the last one takes it
// away. Either changes the default, which no Namespace or asset grant opens.
export function mayChangeInstanceDefault(
  access: ActorAccess,
  surface: AssetWriteSurface,
  kind: WorkflowAssetKind
): boolean {
  return isReleaseSync(access, surface) || access.authorize(kind.actions.write).allowed;
}

export function requireInstanceDefaultChange(
  access: ActorAccess,
  surface: AssetWriteSurface,
  kind: WorkflowAssetKind,
  changesDefault: boolean
): void {
  if (changesDefault && !mayChangeInstanceDefault(access, surface, kind)) {
    access.require(kind.actions.write);
  }
}

/**
 * Where an agent a write creates starts. One that arrives from the CLI starts hidden in every
 * workspace until someone sets its availability: a push must not put an agent in front of
 * every user. One created in the interface starts as the store's default says. So does a
 * write that makes one of its agents the instance default, which is the first agent of an
 * instance: the default must be available everywhere, and the store refuses a hidden one.
 */
export function initialAvailabilityOf(
  origin: OperationOrigin,
  mutations: readonly ConfigAssetMutation[]
): { initialAgentAvailability?: InitialAgentAvailability } {
  const setsDefault = mutations.some(
    (mutation) => mutation.type === "setDefaultAgent" && mutation.agentName !== undefined
  );
  return origin.kind === "cli" && !setsDefault ? { initialAgentAvailability: "selected" } : {};
}

export function setsInitialDefault(set: AssetSet, kind: WorkflowAssetKind): boolean {
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
 * The rules for the agents a write adds or changes that are neither the schema's nor a
 * reference check: the user-selectable models, and the lists of the Namespace the agent is in.
 * Answers every refusal with its agent, and the Namespaces of the instance, which the kind's
 * own editing policy reads next.
 *
 * A Namespace's lists bind every writer, an instance administrator and the release sync
 * included. They only restrict: a null list allows everything, an empty one nothing. An
 * agent's tools are the names in its own `toolNames` and nothing else (a skill is text, and no
 * tool set is added by default), so the tool list is complete once those names are checked.
 */
export async function findChangedAgentRefusals(
  options: ChatServerOptions,
  access: ActorAccess,
  stored: AssetSet,
  validated: AssetSet
): Promise<{ namespaces: Namespace[]; modelIssues: string[]; refusals: ChangedAgentRefusal[] }> {
  const changed = changedAgents(stored, validated);
  const refusals: ChangedAgentRefusal[] = [];
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
  // The Namespaces without their counts: a write reads the prefixes and the lists only.
  const namespaces = await options.stores.access.listNamespaceRecords({
    clientInstanceId: options.clientInstanceId
  });
  for (const { agent } of changed) {
    const namespace = findNamespaceOfAssetName(namespaces, agent.name);
    const error = namespace && namespaceListRefusal(access, namespace, agent);
    if (error) refusals.push({ agentName: agent.name, error });
  }
  return { namespaces, modelIssues, refusals };
}

/** Throws the first refusal of `findChangedAgentRefusals`: the model issues before the lists. */
export async function assertChangedAgentsAllowed(
  options: ChatServerOptions,
  access: ActorAccess,
  stored: AssetSet,
  validated: AssetSet
): Promise<Namespace[]> {
  const found = await findChangedAgentRefusals(options, access, stored, validated);
  if (found.modelIssues.length > 0) {
    throw invalidAssetSet(found.modelIssues);
  }
  const [refusal] = found.refusals;
  if (refusal) {
    throw refusal.error;
  }
  return found.namespaces;
}

function invalidAssetSet(issues: readonly string[]): AppError {
  return new AppError("VALIDATION_FAILED", INVALID_ASSET_SET_MESSAGE, {
    issues: issues.map((message) => ({ message }))
  });
}

function namespaceListRefusal(
  access: ActorAccess,
  namespace: Namespace,
  agent: AgentConfig
): AppError | undefined {
  const allowedToolNames = namespace.allowedToolNames;
  const toolName =
    allowedToolNames && agent.toolNames.find((name) => !allowedToolNames.includes(name));
  if (toolName !== undefined) {
    return new AppError(
      "FORBIDDEN",
      `Tool '${toolName}' is not allowed in Namespace '${namespace.prefix}'`,
      { reason: "tool_not_allowed", toolName, namespace: namespace.prefix }
    );
  }
  const allowedModelBindingIds = namespace.allowedModelBindingIds;
  const modelBindingId =
    allowedModelBindingIds &&
    [
      ...(agent.modelBindingId === undefined ? [] : [agent.modelBindingId]),
      ...(agent.userSelectableModelBindingIds ?? [])
    ].find((id) => !allowedModelBindingIds.includes(id));
  if (modelBindingId !== undefined) {
    return new AppError(
      "FORBIDDEN",
      `Model binding '${modelBindingId}' is not allowed in Namespace '${namespace.prefix}'`,
      { reason: "model_not_allowed", modelBindingId, namespace: namespace.prefix }
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
      `An agent in Namespace '${namespace.prefix}' must select a model binding the Namespace allows`,
      { reason: "model_binding_required", namespace: namespace.prefix }
    );
  }
  return undefined;
}

export function requireMatchingConfigName(config: unknown, expectedName: string): void {
  if (readDefinitionName(config) !== expectedName) {
    throw new AppError("VALIDATION_FAILED", "Config asset name must match the request path");
  }
}

export function requireConfigName(config: unknown): string {
  const name = readDefinitionName(config);
  if (name === undefined) {
    throw new AppError("VALIDATION_FAILED", "Config asset must have a name");
  }
  return name;
}

export function toJsonObject(value: unknown): JsonObject {
  const json = unknownToJsonValue(value);
  if (!isJsonObject(json)) {
    throw new AppError("VALIDATION_FAILED", "Config asset must be a JSON object");
  }
  return json;
}

export function assetKey(kind: ConfigAssetKind, name: string): string {
  return `${kind}:${name}`;
}
