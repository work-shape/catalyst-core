import type { StorePage } from "@vivd-catalyst/core";
import {
  AppError,
  asCollaborationWorkspaceId,
  assertConfigAssetBases,
  type AgentAvailability,
  type ConfigAssetRevisionRecord,
  auditActorFromIdentity,
  findNamespaceOfAssetName,
  isJsonObject,
  unknownToJsonValue,
  type ActorAccess,
  type AgentConfig,
  type AuthenticatedIdentity,
  type ConfigAssetKind,
  type ConfigAssetMutation,
  type ConfigAssetRecord,
  type JsonObject,
  type Namespace,
  type RuntimeCallContext,
  type SkillConfig
} from "@vivd-catalyst/core";
import { findAgentUserSelectableModelIssues } from "@vivd-catalyst/config-schema";
import { agentModelSettingValue } from "./asset-kinds/agent";
import {
  configValuesEqual,
  findNamedDefinition,
  readDefinitionName,
  type ConfigAssetBundle,
  type WorkflowAssetKind
} from "./asset-kinds/shared";
import {
  validateConfigAssetCandidate,
  applyValidatedConfigAssetMutations
} from "./config-asset-writer";
import { recordGovernanceAccess } from "./governance-actions";
import type { ChatServerOptions } from "./types";

type ConfigAssetBundleInput = ConfigAssetBundle;

type ConfigAssetCallContext = Pick<RuntimeCallContext, "correlationId">;

interface PutConfigAssetCommand {
  kind: ConfigAssetKind;
  name: string;
  config: Record<string, unknown>;
  baseVersion?: number;
}

interface AssetMutationCommand {
  kind: ConfigAssetKind;
  name: string;
  baseVersion?: number;
}

export class ConfigAssetWorkflow {
  private readonly options: ChatServerOptions;

  constructor(input: { options: ChatServerOptions }) {
    this.options = input.options;
  }

  async getOverview(user: AuthenticatedIdentity, context: ConfigAssetCallContext) {
    await this.recordAccess(user, context, "governance.config_assets_viewed");
    const [state, assets, availability] = await Promise.all([
      this.options.configAssets.store.getConfigAssetState({
        clientInstanceId: this.options.clientInstanceId
      }),
      this.options.configAssets.store.listActiveConfigAssets({
        clientInstanceId: this.options.clientInstanceId
      }),
      this.options.configAssets.store.listAgentAvailability({
        clientInstanceId: this.options.clientInstanceId
      })
    ]);
    const refs = this.options.configAssets.validationRefs;
    return {
      version: state.version,
      ...(state.defaultAgentName === undefined ? {} : { defaultAgentName: state.defaultAgentName }),
      assets: assets.map((asset) => ({
        id: asset.id,
        kind: asset.kind,
        name: asset.name,
        revision: asset.revision,
        updatedAt: asset.updatedAt,
        ...(this.kind(asset.kind).hasWorkspaceAvailability && availability.has(asset.name)
          ? { availability: availability.get(asset.name) }
          : {})
      })),
      references: {
        ...refs,
        // A tool of a module that is off is not offered for an agent.
        enabledToolNames: refs.enabledToolNames.filter(
          (toolName) => this.options.modules.offModuleOf("tool", toolName) === undefined
        )
      }
    };
  }

  async getAsset(access: ActorAccess, input: { kind: ConfigAssetKind; name: string }) {
    await this.requireAssetAccess(access, "read", input);
    const asset = await this.getActiveAssetOrThrow(input);
    return projectConfigAsset(asset);
  }

  async putAsset(
    user: AuthenticatedIdentity,
    access: ActorAccess,
    context: ConfigAssetCallContext,
    command: PutConfigAssetCommand
  ) {
    const kind = this.kind(command.kind);
    await this.requireAssetAccess(access, "write", command);
    await this.authorizeInteractiveWrite(user, context);
    requireMatchingConfigName(command.config, command.name);
    const current = await this.loadCurrentBundle();
    const currentConfig = findNamedDefinition(kind.definitions(current), command.name);
    const setInitialDefault = shouldSetInitialDefault(current, kind);
    this.requireInstanceDefaultChange(access, kind, setInitialDefault);
    const replaced = replaceBundleAsset(current, kind, {
      name: command.name,
      config: kind.prepareInteractiveUpsert({ current: currentConfig, next: command.config })
    });
    const candidate = setInitialDefault
      ? { ...replaced, defaultAgentName: command.name }
      : replaced;
    const validated = this.validateBundle(candidate);
    this.assertChangedUserSelectableModelsEligible(current, validated.agents);
    const namespaces = await this.assertNamespaceAllowlists(access, current, validated.agents);
    const config = findValidatedConfig(validated, kind, command.name);
    kind.assertInteractiveUpsertAllowed({
      access,
      name: command.name,
      current: currentConfig,
      next: config,
      namespaces
    });
    const mutations: ConfigAssetMutation[] = [
      {
        type: "upsert",
        kind: command.kind,
        name: command.name,
        config: toJsonObject(config)
      }
    ];
    if (setInitialDefault) {
      mutations.push({ type: "setDefaultAgent", agentName: command.name });
    }
    const result = await applyValidatedConfigAssetMutations(this.options, {
      clientInstanceId: this.options.clientInstanceId,
      baseVersion: command.baseVersion,
      actor: auditActorFromIdentity(user),
      mutations
    });
    const updated = await this.getActiveAssetOrThrow(command);
    await this.recordMutation(user, context, "config_asset.updated", {
      kind: command.kind,
      name: command.name,
      revision: updated.revision,
      version: result.version
    });
    return { version: result.version, revision: updated.revision };
  }

  async deleteAsset(
    user: AuthenticatedIdentity,
    access: ActorAccess,
    context: ConfigAssetCallContext,
    command: AssetMutationCommand
  ) {
    const kind = this.kind(command.kind);
    const resource = await this.assetResource(command);
    access.require(kind.actions.delete, resource);
    // A holder who is denied anything on the asset does not delete it: the delete right is no
    // way around a deny on reading or writing.
    for (const action of [kind.actions.read, kind.actions.write]) {
      const decision = access.authorize(action, resource);
      if (!decision.allowed && decision.reason === "denied") {
        access.require(action, resource);
      }
    }
    await this.authorizeInteractiveWrite(user, context);
    kind.assertInteractiveDeleteAllowed();
    const existing = await this.getActiveAssetOrThrow(command);
    const current = await this.loadCurrentBundle();
    const clearLastDefault = shouldClearLastDefault(current, kind, command.name);
    this.requireInstanceDefaultChange(access, kind, clearLastDefault);
    const removed = removeBundleAsset(current, kind, command.name);
    const candidate = clearLastDefault
      ? { agents: removed.agents, skills: removed.skills }
      : removed;
    this.validateBundle(candidate);
    const mutations: ConfigAssetMutation[] = [
      { type: "delete", kind: command.kind, name: command.name }
    ];
    if (clearLastDefault) {
      mutations.push({ type: "setDefaultAgent", agentName: undefined });
    }
    const result = await applyValidatedConfigAssetMutations(this.options, {
      clientInstanceId: this.options.clientInstanceId,
      baseVersion: command.baseVersion,
      actor: auditActorFromIdentity(user),
      mutations
    });
    await this.recordMutation(user, context, "config_asset.deleted", {
      kind: command.kind,
      name: command.name,
      revision: existing.revision + 1,
      version: result.version
    });
    return result;
  }

  async setDefaultAgent(
    user: AuthenticatedIdentity,
    context: ConfigAssetCallContext,
    command: { agentName?: string; baseVersion?: number }
  ) {
    await this.authorizeInteractiveWrite(user, context);
    if (!this.options.config.administration.agentConfiguration.allowDefaultAgentChange) {
      throw new AppError("FORBIDDEN", "Interactive default-agent changes are disabled");
    }
    const current = await this.loadCurrentBundle();
    this.validateBundle({
      agents: current.agents,
      skills: current.skills,
      ...(command.agentName === undefined ? {} : { defaultAgentName: command.agentName })
    });
    const result = await applyValidatedConfigAssetMutations(this.options, {
      clientInstanceId: this.options.clientInstanceId,
      baseVersion: command.baseVersion,
      actor: auditActorFromIdentity(user),
      mutations: [{ type: "setDefaultAgent", agentName: command.agentName }]
    });
    await this.recordMutation(user, context, "config_asset.default_agent_set", {
      agentName: command.agentName ?? null,
      version: result.version
    });
    return result;
  }

  async setAgentAvailability(
    user: AuthenticatedIdentity,
    context: ConfigAssetCallContext,
    command: {
      agentName: string;
      mode: AgentAvailability["mode"];
      personalWorkspaces?: boolean;
      collaborationWorkspaceIds?: string[];
    }
  ): Promise<AgentAvailability> {
    await this.authorizeInteractiveWrite(user, context);
    const selected = command.mode === "selected";
    const collaborationWorkspaceIds = selected
      ? (command.collaborationWorkspaceIds ?? []).map(asCollaborationWorkspaceId)
      : [];
    for (const collaborationWorkspaceId of collaborationWorkspaceIds) {
      const workspace = await this.options.stores.workspaces.getWorkspace(
        this.options.clientInstanceId,
        collaborationWorkspaceId
      );
      if (workspace?.kind !== "shared") {
        throw new AppError(
          "VALIDATION_FAILED",
          `'${collaborationWorkspaceId}' is not a Shared Workspace of this client instance`
        );
      }
    }
    const availability = await this.options.configAssets.store.setAgentAvailability({
      clientInstanceId: this.options.clientInstanceId,
      agentName: command.agentName,
      availability: {
        mode: command.mode,
        personalWorkspaces: selected && command.personalWorkspaces === true,
        collaborationWorkspaceIds
      }
    });
    await this.recordMutation(user, context, "config_asset.availability_set", {
      kind: "agent",
      name: command.agentName,
      mode: availability.mode,
      personalWorkspaces: availability.personalWorkspaces,
      collaborationWorkspaceIds: availability.collaborationWorkspaceIds
    });
    return availability;
  }

  /** The Shared Workspaces an instance admin can make an agent available in. */
  async listAdministeredWorkspaces() {
    const workspaces = await this.options.stores.workspaces.listSharedWorkspaces({
      clientInstanceId: this.options.clientInstanceId
    });
    return workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      createdAt: workspace.createdAt
    }));
  }

  async listRevisions(
    access: ActorAccess,
    input: { kind: ConfigAssetKind; name: string; page?: StorePage }
  ) {
    await this.requireAssetAccess(access, "read", input);
    const revisions = await this.options.configAssets.store.listConfigAssetRevisions({
      clientInstanceId: this.options.clientInstanceId,
      ...input
    });
    return revisions.map((revision) => ({
      revision: revision.revision,
      operation: revision.operation,
      config: revision.config,
      actor: revision.actor,
      origin: revision.origin,
      globalVersion: revision.globalVersion,
      createdAt: revision.createdAt
    }));
  }

  async revertAsset(
    user: AuthenticatedIdentity,
    access: ActorAccess,
    context: ConfigAssetCallContext,
    command: AssetMutationCommand & { revision: number }
  ) {
    const kind = this.kind(command.kind);
    await this.requireAssetAccess(access, "write", command);
    await this.authorizeInteractiveWrite(user, context);
    const revisions = await this.options.configAssets.store.listConfigAssetRevisions({
      clientInstanceId: this.options.clientInstanceId,
      kind: command.kind,
      name: command.name
    });
    const target = revisions.find((revision) => revision.revision === command.revision);
    if (!target || target.config === null) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Config asset revision ${command.revision} does not contain a restorable config`
      );
    }
    requireMatchingConfigName(target.config, command.name);
    const current = await this.loadCurrentBundle();
    const setInitialDefault = shouldSetInitialDefault(current, kind);
    this.requireInstanceDefaultChange(access, kind, setInitialDefault);
    const replaced = replaceBundleAsset(current, kind, {
      name: command.name,
      config: target.config
    });
    const candidate = setInitialDefault
      ? { ...replaced, defaultAgentName: command.name }
      : replaced;
    const validated = this.validateBundle(candidate);
    this.assertChangedUserSelectableModelsEligible(current, validated.agents);
    const namespaces = await this.assertNamespaceAllowlists(access, current, validated.agents);
    const config = findValidatedConfig(validated, kind, command.name);
    kind.assertInteractiveUpsertAllowed({
      access,
      name: command.name,
      current: findNamedDefinition(kind.definitions(current), command.name),
      next: config,
      namespaces
    });
    const mutations: ConfigAssetMutation[] = [
      {
        type: "upsert",
        kind: command.kind,
        name: command.name,
        config: toJsonObject(config),
        operation: "revert"
      }
    ];
    if (setInitialDefault) {
      mutations.push({ type: "setDefaultAgent", agentName: command.name });
    }
    const result = await applyValidatedConfigAssetMutations(this.options, {
      clientInstanceId: this.options.clientInstanceId,
      baseVersion: command.baseVersion,
      actor: auditActorFromIdentity(user),
      mutations
    });
    const updated = await this.getActiveAssetOrThrow(command);
    await this.recordMutation(user, context, "config_asset.reverted", {
      kind: command.kind,
      name: command.name,
      revision: updated.revision,
      version: result.version
    });
    return { version: result.version, revision: updated.revision };
  }

  async exportAssets(user: AuthenticatedIdentity, context: ConfigAssetCallContext) {
    await this.recordAccess(user, context, "governance.config_assets_viewed");
    const [state, assets] = await Promise.all([
      this.options.configAssets.store.getConfigAssetState({
        clientInstanceId: this.options.clientInstanceId
      }),
      this.options.configAssets.store.listActiveConfigAssets({
        clientInstanceId: this.options.clientInstanceId
      })
    ]);
    return {
      version: state.version,
      perAssetConcurrency: true as const,
      revisions: Object.fromEntries(
        assets.map((asset) => [assetKey(asset.kind, asset.name), asset.revision])
      ),
      ...this.assetBundle(assets, state.defaultAgentName)
    };
  }

  async replaceAssets(
    user: AuthenticatedIdentity,
    access: ActorAccess,
    context: ConfigAssetCallContext,
    command: ConfigAssetBundleInput & {
      baseVersion: number | null;
      mode?: "mirror" | "merge";
      baseRevisions?: Record<string, number | null>;
      baseDefaultAgentName?: string | null;
      deleteAssets?: Array<{ kind: ConfigAssetKind; name: string }>;
    }
  ) {
    await this.recordAccess(user, context, "governance.config_assets_release_authorized");
    const [currentState, currentAssets] = await Promise.all([
      this.options.configAssets.store.getConfigAssetState({
        clientInstanceId: this.options.clientInstanceId
      }),
      this.options.configAssets.store.listActiveConfigAssets({
        clientInstanceId: this.options.clientInstanceId
      })
    ]);
    const merge = command.mode === "merge";
    const kinds = this.options.configAssets.kinds.kinds;
    const currentBundle = this.assetBundle(currentAssets, currentState.defaultAgentName);
    let candidate: ConfigAssetBundleInput = merge
      ? mergeBundle(kinds, currentBundle, command)
      : command;
    for (const asset of command.deleteAssets ?? []) {
      candidate = removeBundleAsset(candidate, this.kind(asset.kind), asset.name);
    }
    const provided = kinds.map((kind) => ({
      kind,
      names: new Set(kind.definitions(command).map(readDefinitionName))
    }));
    if (command.baseDefaultAgentName !== undefined) {
      candidate = { ...candidate, defaultAgentName: command.defaultAgentName };
    }
    if (command.baseRevisions !== undefined) {
      const touched = [
        ...kinds.flatMap((kind) =>
          kind.definitions(command).map((config) => ({
            kind: kind.kind,
            name: requireConfigName(config)
          }))
        ),
        ...(command.deleteAssets ?? []),
        ...(!merge
          ? currentAssets.filter(
              (asset) =>
                findNamedDefinition(this.kind(asset.kind).definitions(candidate), asset.name) ===
                undefined
            )
          : [])
      ];
      const current = new Map<
        string,
        { status: "active" | "deleted"; revision: ConfigAssetRevisionRecord }
      >();
      for (const asset of touched) {
        const revisions = await this.options.configAssets.store.listConfigAssetRevisions({
          clientInstanceId: this.options.clientInstanceId,
          kind: asset.kind,
          name: asset.name
        });
        const revision = revisions.at(-1);
        if (revision) {
          current.set(assetKey(asset.kind, asset.name), {
            status: revision.operation === "delete" ? "deleted" : "active",
            revision
          });
        }
      }
      const guards: ConfigAssetMutation[] = touched.map((asset) => ({
        type: "delete",
        kind: asset.kind,
        name: asset.name
      }));
      if (
        !merge ||
        command.defaultAgentName !== undefined ||
        command.baseDefaultAgentName !== undefined
      ) {
        guards.push({ type: "setDefaultAgent", agentName: command.defaultAgentName });
      }
      // Report stale assets before validating references changed or deleted remotely.
      // The store repeats these checks under its lock before applying the batch.
      assertConfigAssetBases(
        {
          clientInstanceId: this.options.clientInstanceId,
          baseRevisions: command.baseRevisions,
          baseDefaultAgentName: command.baseDefaultAgentName,
          mutations: guards
        },
        currentState,
        current
      );
    }
    const validated = this.validateBundle(candidate);
    this.assertChangedUserSelectableModelsEligible(currentBundle, validated.agents);
    await this.assertNamespaceAllowlists(access, currentBundle, validated.agents);
    const validatedBundle: ConfigAssetBundleInput = validated;
    /** What the caller sent of one kind, as validated. */
    const providedDefinitions = ({ kind, names }: (typeof provided)[number]) =>
      kind.definitions(validatedBundle).flatMap((config) => {
        const name = readDefinitionName(config);
        return name !== undefined && names.has(name) ? [{ name, config }] : [];
      });
    const desiredKeys = new Set(
      kinds.flatMap((kind) =>
        kind
          .definitions(validatedBundle)
          .map((config) => assetKey(kind.kind, requireConfigName(config)))
      )
    );
    const mutations: ConfigAssetMutation[] = merge
      ? []
      : currentAssets
          .filter((asset) => !desiredKeys.has(assetKey(asset.kind, asset.name)))
          .map((asset) => ({ type: "delete", kind: asset.kind, name: asset.name }));
    mutations.push(
      ...(command.deleteAssets ?? []).map((asset) => ({
        type: "delete" as const,
        ...asset
      }))
    );
    mutations.push(
      ...provided.flatMap((entry) =>
        providedDefinitions(entry).map(({ name, config }) => ({
          type: "upsert" as const,
          kind: entry.kind.kind,
          name,
          config: toJsonObject(config)
        }))
      )
    );
    if (
      !merge ||
      command.defaultAgentName !== undefined ||
      command.baseDefaultAgentName !== undefined
    ) {
      mutations.push({ type: "setDefaultAgent", agentName: command.defaultAgentName });
    }
    const result = await applyValidatedConfigAssetMutations(this.options, {
      clientInstanceId: this.options.clientInstanceId,
      ...(command.baseVersion === null ? {} : { baseVersion: command.baseVersion }),
      baseRevisions: command.baseRevisions,
      baseDefaultAgentName: command.baseDefaultAgentName,
      actor: auditActorFromIdentity(user),
      initialAgentAvailability: "selected_when_replacing_selected",
      mutations
    });
    await this.recordMutation(user, context, "config_assets.replaced", {
      version: result.version
    });
    const availability = await this.options.configAssets.store.listAgentAvailability({
      clientInstanceId: this.options.clientInstanceId
    });
    const hiddenAgentNames = provided
      .filter((entry) => entry.kind.hasWorkspaceAvailability)
      .flatMap((entry) => providedDefinitions(entry).map(({ name }) => name))
      .filter((name) => isHiddenEverywhere(availability.get(name)));
    return { ...result, ...(hiddenAgentNames.length > 0 ? { hiddenAgentNames } : {}) };
  }

  async validateAssets(
    user: AuthenticatedIdentity,
    access: ActorAccess,
    context: ConfigAssetCallContext,
    command: ConfigAssetBundleInput
  ): Promise<{ valid: true }> {
    await this.recordAccess(user, context, "governance.config_assets_release_authorized");
    const validated = this.validateBundle(command);
    const current = await this.loadCurrentBundle();
    this.assertChangedUserSelectableModelsEligible(current, validated.agents);
    await this.assertNamespaceAllowlists(access, current, validated.agents);
    return { valid: true };
  }

  // Rights that do not depend on the asset are the operation's `requires`, answered at instance
  // scope. A right on one agent or one skill is checked here, where kind and name are known, so
  // a grant in a Namespace or on the asset itself can answer it. The refusal is the same
  // whether or not the asset exists.
  private async requireAssetAccess(
    access: ActorAccess,
    verb: "read" | "write",
    input: { kind: ConfigAssetKind; name: string }
  ): Promise<void> {
    access.require(this.kind(input.kind).actions[verb], await this.assetResource(input));
  }

  private kind(kind: string): WorkflowAssetKind {
    return this.options.configAssets.kinds.require(kind);
  }

  private assetBundle(assets: ConfigAssetRecord[], defaultAgentName?: string) {
    return assetBundle(this.options.configAssets.kinds.kinds, assets, defaultAgentName);
  }

  private async assetResource(input: { kind: ConfigAssetKind; name: string }) {
    const asset = await this.options.configAssets.store.getConfigAsset({
      clientInstanceId: this.options.clientInstanceId,
      kind: input.kind,
      name: input.name
    });
    // A deleted asset keeps its row, its revisions and the deny rows on it, so its history and
    // its name are decided with the same id as before the delete.
    return { kind: input.kind, name: input.name, ...(asset ? { assetId: asset.id } : {}) };
  }

  // The first asset of a kind with an instance default becomes it and the last one takes it
  // away. Either changes the default, which no Namespace or asset grant opens.
  private requireInstanceDefaultChange(
    access: ActorAccess,
    kind: WorkflowAssetKind,
    changesDefault: boolean
  ): void {
    if (changesDefault) {
      access.require(kind.actions.write);
    }
  }

  /**
   * A Namespace's lists bind every writer, an instance administrator and the release sync
   * included. They are checked for every agent a write creates or changes and only restrict:
   * a null list allows everything, an empty one nothing. An agent's tools are the names in its
   * own `toolNames` and nothing else (a skill is text, and no tool set is added by default), so
   * the tool list is complete once those names are checked.
   */
  private async assertNamespaceAllowlists(
    access: ActorAccess,
    current: ConfigAssetBundleInput,
    nextAgents: AgentConfig[]
  ): Promise<Namespace[]> {
    const namespaces = await this.options.stores.access.listNamespaces({
      clientInstanceId: this.options.clientInstanceId
    });
    for (const agent of nextAgents) {
      const namespace = findNamespaceOfAssetName(namespaces, agent.name);
      if (
        !namespace ||
        configValuesEqual(findNamedDefinition(current.agents, agent.name), toJsonObject(agent))
      ) {
        continue;
      }
      const allowedToolNames = namespace.allowedToolNames;
      const toolName =
        allowedToolNames && agent.toolNames.find((name) => !allowedToolNames.includes(name));
      if (toolName !== undefined) {
        throw new AppError(
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
        throw new AppError(
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
        throw new AppError(
          "FORBIDDEN",
          `An agent in Namespace '${namespace.prefix}' must select a model binding the Namespace allows`,
          { reason: "model_binding_required", namespace: namespace.prefix }
        );
      }
    }
    return namespaces;
  }

  private recordAccess(
    user: AuthenticatedIdentity,
    context: ConfigAssetCallContext,
    auditType: string
  ): Promise<void> {
    return recordGovernanceAccess({ options: this.options, user, context, auditType });
  }

  private async authorizeInteractiveWrite(
    user: AuthenticatedIdentity,
    context: ConfigAssetCallContext
  ): Promise<void> {
    await this.recordAccess(user, context, "governance.config_assets_write_authorized");
    if (!this.options.modules.isEnabled("assetManagement")) {
      throw new AppError("FORBIDDEN", "Interactive agent configuration is disabled");
    }
  }

  /**
   * An agent's list of user-selectable models must name eligible bindings whenever it is written.
   * Unchanged lists are not re-checked, so a binding that later disappears or stops being
   * agent-selectable never blocks other edits; such ids are ignored at read time.
   */
  private assertChangedUserSelectableModelsEligible(
    current: ConfigAssetBundleInput,
    nextAgents: AgentConfig[]
  ): void {
    const eligibleIds = this.options.configAssets.validationRefs.modelBindingIds;
    const issues = nextAgents
      .filter(
        (agent) =>
          !configValuesEqual(
            agentModelSettingValue(
              findNamedDefinition(current.agents, agent.name),
              "userSelectableModelBindingIds"
            ),
            agentModelSettingValue(agent, "userSelectableModelBindingIds")
          )
      )
      .flatMap((agent) => findAgentUserSelectableModelIssues(agent, eligibleIds));
    if (issues.length > 0) {
      throw new AppError("VALIDATION_FAILED", "Config asset bundle is invalid", {
        issues: issues.map((message) => ({ message }))
      });
    }
  }

  private validateBundle(input: ConfigAssetBundleInput): {
    agents: AgentConfig[];
    skills: SkillConfig[];
  } {
    return validateConfigAssetCandidate(this.options, input);
  }

  private async loadCurrentBundle(): Promise<ConfigAssetBundleInput> {
    const [state, assets] = await Promise.all([
      this.options.configAssets.store.getConfigAssetState({
        clientInstanceId: this.options.clientInstanceId
      }),
      this.options.configAssets.store.listActiveConfigAssets({
        clientInstanceId: this.options.clientInstanceId
      })
    ]);
    return this.assetBundle(assets, state.defaultAgentName);
  }

  private async getActiveAssetOrThrow(input: {
    kind: ConfigAssetKind;
    name: string;
  }): Promise<ConfigAssetRecord> {
    const asset = await this.options.configAssets.store.getConfigAsset({
      clientInstanceId: this.options.clientInstanceId,
      ...input
    });
    if (!asset || asset.status !== "active" || asset.config === null) {
      throw new AppError("NOT_FOUND", `Config ${input.kind} '${input.name}' was not found`);
    }
    return asset;
  }

  private async recordMutation(
    user: AuthenticatedIdentity,
    context: ConfigAssetCallContext,
    type: string,
    metadata: JsonObject
  ): Promise<void> {
    await this.options.auditRecorder.record({
      type,
      status: "success",
      actor: auditActorFromIdentity(user),
      correlationId: context.correlationId,
      metadata
    });
  }
}

function isHiddenEverywhere(availability: AgentAvailability | undefined): boolean {
  return (
    !availability ||
    (availability.mode === "selected" &&
      !availability.personalWorkspaces &&
      availability.collaborationWorkspaceIds.length === 0)
  );
}

function projectConfigAsset(asset: ConfigAssetRecord) {
  if (asset.config === null) {
    throw new AppError("NOT_FOUND", `Config ${asset.kind} '${asset.name}' was not found`);
  }
  return {
    kind: asset.kind,
    name: asset.name,
    revision: asset.revision,
    config: asset.config,
    updatedAt: asset.updatedAt
  };
}

function assetBundle(
  kinds: readonly WorkflowAssetKind[],
  assets: ConfigAssetRecord[],
  defaultAgentName?: string
): ConfigAssetBundle<JsonObject> {
  return kinds.reduce<ConfigAssetBundle<JsonObject>>(
    (bundle, kind) =>
      kind.withDefinitions(
        bundle,
        assets.flatMap((asset) =>
          asset.kind === kind.kind && asset.config !== null ? [asset.config] : []
        )
      ),
    { ...(defaultAgentName === undefined ? {} : { defaultAgentName }), agents: [], skills: [] }
  );
}

function mergeBundle(
  kinds: readonly WorkflowAssetKind[],
  current: ConfigAssetBundleInput,
  incoming: ConfigAssetBundleInput
): ConfigAssetBundleInput {
  const defaultAgentName = incoming.defaultAgentName ?? current.defaultAgentName;
  return kinds.reduce<ConfigAssetBundleInput>(
    (bundle, kind) => {
      const incomingNames = new Set(kind.definitions(incoming).map(readDefinitionName));
      return kind.withDefinitions(bundle, [
        ...kind
          .definitions(current)
          .filter((config) => !incomingNames.has(readDefinitionName(config))),
        ...kind.definitions(incoming)
      ]);
    },
    { ...(defaultAgentName === undefined ? {} : { defaultAgentName }), agents: [], skills: [] }
  );
}

function replaceBundleAsset(
  bundle: ConfigAssetBundleInput,
  kind: WorkflowAssetKind,
  input: { name: string; config: Record<string, unknown> }
): ConfigAssetBundleInput {
  return kind.withDefinitions(bundle, [
    ...withoutNamedConfig(kind.definitions(bundle), input.name),
    input.config
  ]);
}

function removeBundleAsset(
  bundle: ConfigAssetBundleInput,
  kind: WorkflowAssetKind,
  name: string
): ConfigAssetBundleInput {
  return kind.withDefinitions(bundle, withoutNamedConfig(kind.definitions(bundle), name));
}

function withoutNamedConfig(configs: unknown[], name: string): unknown[] {
  return configs.filter((config) => readDefinitionName(config) !== name);
}

function requireMatchingConfigName(config: unknown, expectedName: string): void {
  if (readDefinitionName(config) !== expectedName) {
    throw new AppError("VALIDATION_FAILED", "Config asset name must match the request path");
  }
}

function requireConfigName(config: unknown): string {
  const name = readDefinitionName(config);
  if (name === undefined) {
    throw new AppError("VALIDATION_FAILED", "Config asset must have a name");
  }
  return name;
}

function findValidatedConfig(
  bundle: ConfigAssetBundleInput,
  kind: WorkflowAssetKind,
  name: string
): unknown {
  const config = findNamedDefinition(kind.definitions(bundle), name);
  if (config === undefined) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Validated config ${kind.kind} '${name}' was not found`
    );
  }
  return config;
}

function toJsonObject(value: unknown): JsonObject {
  const json = unknownToJsonValue(value);
  if (!isJsonObject(json)) {
    throw new AppError("VALIDATION_FAILED", "Config asset must be a JSON object");
  }
  return json;
}

function assetKey(kind: ConfigAssetKind, name: string): string {
  return `${kind}:${name}`;
}

function shouldSetInitialDefault(bundle: ConfigAssetBundleInput, kind: WorkflowAssetKind): boolean {
  return (
    kind.holdsInstanceDefault &&
    kind.definitions(bundle).length === 0 &&
    bundle.defaultAgentName === undefined
  );
}

function shouldClearLastDefault(
  bundle: ConfigAssetBundleInput,
  kind: WorkflowAssetKind,
  name: string
): boolean {
  return (
    kind.holdsInstanceDefault &&
    kind.definitions(bundle).length === 1 &&
    bundle.defaultAgentName === name
  );
}
