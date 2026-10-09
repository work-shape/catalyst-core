import {
  AGENT_EDITABLE_FIELDS,
  AGENT_MODEL_SETTING_FIELDS,
  AppError,
  asCollaborationWorkspaceId,
  assertConfigAssetBases,
  type AgentAvailability,
  type ConfigAssetRevisionRecord,
  auditActorFromIdentity,
  hasPermission,
  isJsonObject,
  legacyPermissionFor,
  requirePermission,
  unknownToJsonValue,
  type AgentConfig,
  type AgentEditableField,
  type AgentModelSettingField,
  type AuthenticatedIdentity,
  type ConfigAssetKind,
  type ConfigAssetMutation,
  type ConfigAssetRecord,
  type JsonObject,
  type PlatformAction,
  type RuntimeCallContext,
  type SkillConfig
} from "@vivd-catalyst/core";
import { findAgentUserSelectableModelIssues } from "@vivd-catalyst/config-schema";
import {
  validateConfigAssetCandidate,
  applyValidatedConfigAssetMutations
} from "./config-asset-writer";
import { recordGovernanceAccess } from "./governance-actions";
import type { ChatServerOptions } from "./types";

interface ConfigAssetBundleInput {
  defaultAgentName?: string;
  agents: unknown[];
  skills: unknown[];
}

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
    return {
      version: state.version,
      ...(state.defaultAgentName === undefined ? {} : { defaultAgentName: state.defaultAgentName }),
      assets: assets.map((asset) => ({
        kind: asset.kind,
        name: asset.name,
        revision: asset.revision,
        updatedAt: asset.updatedAt,
        ...(asset.kind === "agent" && availability.has(asset.name)
          ? { availability: availability.get(asset.name) }
          : {})
      })),
      references: this.options.configAssets.validationRefs
    };
  }

  async getAsset(user: AuthenticatedIdentity, input: { kind: ConfigAssetKind; name: string }) {
    requirePermission(user, legacyPermissionFor(`${input.kind}.read`));
    const asset = await this.getActiveAssetOrThrow(input);
    return projectConfigAsset(asset);
  }

  async putAsset(
    user: AuthenticatedIdentity,
    context: ConfigAssetCallContext,
    command: PutConfigAssetCommand
  ) {
    this.requireAssetWrite(user, `${command.kind}.write`);
    await this.authorizeInteractiveWrite(user, context);
    requireMatchingConfigName(command.config, command.name);
    const current = await this.loadCurrentBundle();
    const setInitialDefault = shouldSetInitialDefault(current, command.kind);
    const replaced = replaceBundleAsset(current, {
      ...command,
      config:
        command.kind === "agent"
          ? this.clearFastModeOnBindingSwitch(
              findBundleConfig(current, "agent", command.name),
              command.config
            )
          : command.config
    });
    const candidate = setInitialDefault
      ? { ...replaced, defaultAgentName: command.name }
      : replaced;
    const validated = this.validateBundle(candidate);
    this.assertChangedUserSelectableModelsEligible(current, validated.agents);
    const config = findValidatedConfig(validated, command.kind, command.name);
    this.assertInteractiveAssetUpsertAllowed({
      user,
      kind: command.kind,
      name: command.name,
      currentConfig: findBundleConfig(current, command.kind, command.name),
      nextConfig: config
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
    context: ConfigAssetCallContext,
    command: AssetMutationCommand
  ) {
    this.requireAssetWrite(user, `${command.kind}.delete`);
    await this.authorizeInteractiveWrite(user, context);
    this.assertInteractiveDeleteAllowed(command.kind);
    const existing = await this.getActiveAssetOrThrow(command);
    const current = await this.loadCurrentBundle();
    const clearLastDefault = shouldClearLastDefault(current, command);
    const removed = removeBundleAsset(current, command);
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
      const workspace = await this.options.userStore.getWorkspace(
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
    const workspaces = await this.options.userStore.listSharedWorkspaces({
      clientInstanceId: this.options.clientInstanceId
    });
    return workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name }));
  }

  async listRevisions(user: AuthenticatedIdentity, input: { kind: ConfigAssetKind; name: string }) {
    requirePermission(user, legacyPermissionFor(`${input.kind}.read`));
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
    context: ConfigAssetCallContext,
    command: AssetMutationCommand & { revision: number }
  ) {
    this.requireAssetWrite(user, `${command.kind}.write`);
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
    const setInitialDefault = shouldSetInitialDefault(current, command.kind);
    const replaced = replaceBundleAsset(current, {
      kind: command.kind,
      name: command.name,
      config: target.config
    });
    const candidate = setInitialDefault
      ? { ...replaced, defaultAgentName: command.name }
      : replaced;
    const validated = this.validateBundle(candidate);
    this.assertChangedUserSelectableModelsEligible(current, validated.agents);
    const config = findValidatedConfig(validated, command.kind, command.name);
    this.assertInteractiveAssetUpsertAllowed({
      user,
      kind: command.kind,
      name: command.name,
      currentConfig: findBundleConfig(current, command.kind, command.name),
      nextConfig: config
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
      ...(state.defaultAgentName === undefined ? {} : { defaultAgentName: state.defaultAgentName }),
      agents: assetConfigs(assets, "agent"),
      skills: assetConfigs(assets, "skill")
    };
  }

  async replaceAssets(
    user: AuthenticatedIdentity,
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
    let candidate = merge
      ? mergeBundle(assetBundle(currentAssets, currentState.defaultAgentName), command)
      : command;
    for (const asset of command.deleteAssets ?? []) {
      candidate = removeBundleAsset(candidate, asset);
    }
    if (command.baseDefaultAgentName !== undefined) {
      candidate = { ...candidate, defaultAgentName: command.defaultAgentName };
    }
    if (command.baseRevisions !== undefined) {
      const touched = [
        ...command.agents.map((config) => ({
          kind: "agent" as const,
          name: requireConfigName(config)
        })),
        ...command.skills.map((config) => ({
          kind: "skill" as const,
          name: requireConfigName(config)
        })),
        ...(command.deleteAssets ?? []),
        ...(!merge
          ? currentAssets.filter(
              (asset) =>
                !candidate.agents.some(
                  (config) => asset.kind === "agent" && readConfigName(config) === asset.name
                ) &&
                !candidate.skills.some(
                  (config) => asset.kind === "skill" && readConfigName(config) === asset.name
                )
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
    this.assertChangedUserSelectableModelsEligible(
      assetBundle(currentAssets, currentState.defaultAgentName),
      validated.agents
    );
    const providedAgentNames = new Set(command.agents.map(readConfigName));
    const providedSkillNames = new Set(command.skills.map(readConfigName));
    const desiredKeys = new Set([
      ...validated.agents.map((agent) => assetKey("agent", agent.name)),
      ...validated.skills.map((skill) => assetKey("skill", skill.name))
    ]);
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
      ...validated.agents
        .filter((agent) => providedAgentNames.has(agent.name))
        .map((agent) => ({
          type: "upsert" as const,
          kind: "agent" as const,
          name: agent.name,
          config: toJsonObject(agent)
        })),
      ...validated.skills
        .filter((skill) => providedSkillNames.has(skill.name))
        .map((skill) => ({
          type: "upsert" as const,
          kind: "skill" as const,
          name: skill.name,
          config: toJsonObject(skill)
        }))
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
    const hiddenAgentNames = validated.agents
      .filter((agent) => providedAgentNames.has(agent.name))
      .map((agent) => agent.name)
      .filter((name) => isHiddenEverywhere(availability.get(name)));
    return { ...result, ...(hiddenAgentNames.length > 0 ? { hiddenAgentNames } : {}) };
  }

  async validateAssets(
    user: AuthenticatedIdentity,
    context: ConfigAssetCallContext,
    command: ConfigAssetBundleInput
  ): Promise<{ valid: true }> {
    await this.recordAccess(user, context, "governance.config_assets_release_authorized");
    const validated = this.validateBundle(command);
    this.assertChangedUserSelectableModelsEligible(
      await this.loadCurrentBundle(),
      validated.agents
    );
    return { valid: true };
  }

  // Rights that do not depend on the asset kind are the operation's `requires`. A right on
  // one agent or one skill is checked here, where the kind is known.
  private requireAssetWrite(
    user: AuthenticatedIdentity,
    action: Extract<PlatformAction, `${ConfigAssetKind}.${"write" | "delete"}`>
  ): void {
    if (!hasPermission(user, legacyPermissionFor(action))) {
      throw new AppError(
        "FORBIDDEN",
        "Config asset changes require 'config_assets.write' permission"
      );
    }
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
    if (!this.options.config.administration.agentConfiguration.enabled) {
      throw new AppError("FORBIDDEN", "Interactive agent configuration is disabled");
    }
  }

  private assertInteractiveDeleteAllowed(kind: ConfigAssetKind): void {
    const policy = this.options.config.administration.agentConfiguration;
    if (kind === "skill" && !policy.allowSkillEditing) {
      throw new AppError("FORBIDDEN", "Interactive skill editing is disabled");
    }
    if (kind === "agent" && !policy.allowAgentDeletion) {
      throw new AppError("FORBIDDEN", "Interactive agent deletion is disabled");
    }
  }

  /** Switching to a binding without fast-mode support clears the flag instead of failing the save. */
  private clearFastModeOnBindingSwitch(
    currentConfig: AgentConfig | SkillConfig | undefined,
    nextConfig: Record<string, unknown>
  ): Record<string, unknown> {
    const currentBindingId = (currentConfig as AgentConfig | undefined)?.modelBindingId;
    const nextBindingId = nextConfig.modelBindingId;
    if (
      nextConfig.fastMode !== true ||
      nextBindingId === currentBindingId ||
      (typeof nextBindingId === "string" &&
        this.options.configAssets.validationRefs.fastModeModelBindingIds.includes(nextBindingId))
    ) {
      return nextConfig;
    }
    const { fastMode: _fastMode, ...withoutFastMode } = nextConfig;
    return withoutFastMode;
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
            modelSettingValue(
              findBundleConfig(current, "agent", agent.name) as AgentConfig | undefined,
              "userSelectableModelBindingIds"
            ),
            modelSettingValue(agent, "userSelectableModelBindingIds")
          )
      )
      .flatMap((agent) => findAgentUserSelectableModelIssues(agent, eligibleIds));
    if (issues.length > 0) {
      throw new AppError("VALIDATION_FAILED", "Config asset bundle is invalid", {
        issues: issues.map((message) => ({ message }))
      });
    }
  }

  private assertInteractiveAssetUpsertAllowed(input: {
    user: AuthenticatedIdentity;
    kind: ConfigAssetKind;
    name: string;
    currentConfig: AgentConfig | SkillConfig | undefined;
    nextConfig: AgentConfig | SkillConfig;
  }): void {
    const policy = this.options.config.administration.agentConfiguration;
    if (input.kind === "skill") {
      if (!policy.allowSkillEditing) {
        throw new AppError("FORBIDDEN", "Interactive skill editing is disabled");
      }
      return;
    }
    if (!input.currentConfig && !policy.allowAgentCreation) {
      throw new AppError("FORBIDDEN", "Interactive agent creation is disabled");
    }

    const currentAgent = input.currentConfig as AgentConfig | undefined;
    const nextAgent = input.nextConfig as AgentConfig;
    const editableFields = new Set<AgentEditableField>(policy.editableAgentFields);
    const changedFields = AGENT_EDITABLE_FIELDS.filter(
      (field) => !configValuesEqual(currentAgent?.[field], nextAgent[field])
    );
    // Model settings are governed by a permission, not by the editable-field policy.
    const changedModelSettings = AGENT_MODEL_SETTING_FIELDS.filter(
      (field) =>
        !configValuesEqual(
          modelSettingValue(currentAgent, field),
          modelSettingValue(nextAgent, field)
        )
    );
    if (changedModelSettings.length > 0 && !hasPermission(input.user, "agent_models.manage")) {
      throw new AppError(
        "FORBIDDEN",
        `Changing agent model settings (${changedModelSettings.join(", ")}) requires 'agent_models.manage' permission`
      );
    }
    const protectedFields = changedFields.filter(
      (field) => !editableFields.has(field) && !isAgentModelSettingField(field)
    );
    if (protectedFields.length > 0) {
      throw new AppError(
        "FORBIDDEN",
        `Interactive changes are not allowed for agent field${protectedFields.length === 1 ? "" : "s"}: ${protectedFields.join(", ")}`
      );
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
    return {
      ...(state.defaultAgentName === undefined ? {} : { defaultAgentName: state.defaultAgentName }),
      agents: assetConfigs(assets, "agent"),
      skills: assetConfigs(assets, "skill")
    };
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

function isAgentModelSettingField(field: string): field is AgentModelSettingField {
  return (AGENT_MODEL_SETTING_FIELDS as readonly string[]).includes(field);
}

function modelSettingValue(agent: AgentConfig | undefined, field: AgentModelSettingField) {
  if (field === "fastMode") {
    return agent?.fastMode ?? false;
  }
  if (field === "userSelectableModelBindingIds") {
    return agent?.userSelectableModelBindingIds ?? [];
  }
  if (field === "modelReasoningEfforts") {
    return agent?.modelReasoningEfforts ?? {};
  }
  return agent?.[field];
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

function assetConfigs(assets: ConfigAssetRecord[], kind: ConfigAssetKind): JsonObject[] {
  return assets.flatMap((asset) =>
    asset.kind === kind && asset.config !== null ? [asset.config] : []
  );
}

function assetBundle(
  assets: ConfigAssetRecord[],
  defaultAgentName?: string
): ConfigAssetBundleInput {
  return {
    ...(defaultAgentName === undefined ? {} : { defaultAgentName }),
    agents: assetConfigs(assets, "agent"),
    skills: assetConfigs(assets, "skill")
  };
}

function mergeBundle(
  current: ConfigAssetBundleInput,
  incoming: ConfigAssetBundleInput
): ConfigAssetBundleInput {
  const incomingAgentNames = new Set(incoming.agents.map(readConfigName));
  const incomingSkillNames = new Set(incoming.skills.map(readConfigName));
  return {
    ...(incoming.defaultAgentName === undefined
      ? current.defaultAgentName === undefined
        ? {}
        : { defaultAgentName: current.defaultAgentName }
      : { defaultAgentName: incoming.defaultAgentName }),
    agents: [
      ...current.agents.filter((config) => !incomingAgentNames.has(readConfigName(config))),
      ...incoming.agents
    ],
    skills: [
      ...current.skills.filter((config) => !incomingSkillNames.has(readConfigName(config))),
      ...incoming.skills
    ]
  };
}

function replaceBundleAsset(
  bundle: ConfigAssetBundleInput,
  input: {
    kind: ConfigAssetKind;
    name: string;
    config: Record<string, unknown>;
  }
): ConfigAssetBundleInput {
  return {
    ...bundle,
    agents:
      input.kind === "agent"
        ? [...withoutNamedConfig(bundle.agents, input.name), input.config]
        : bundle.agents,
    skills:
      input.kind === "skill"
        ? [...withoutNamedConfig(bundle.skills, input.name), input.config]
        : bundle.skills
  };
}

function removeBundleAsset(
  bundle: ConfigAssetBundleInput,
  input: { kind: ConfigAssetKind; name: string }
): ConfigAssetBundleInput {
  return {
    ...bundle,
    agents: input.kind === "agent" ? withoutNamedConfig(bundle.agents, input.name) : bundle.agents,
    skills: input.kind === "skill" ? withoutNamedConfig(bundle.skills, input.name) : bundle.skills
  };
}

function withoutNamedConfig(configs: unknown[], name: string): unknown[] {
  return configs.filter((config) => readConfigName(config) !== name);
}

function requireMatchingConfigName(config: unknown, expectedName: string): void {
  if (readConfigName(config) !== expectedName) {
    throw new AppError("VALIDATION_FAILED", "Config asset name must match the request path");
  }
}

function requireConfigName(config: unknown): string {
  const name = readConfigName(config);
  if (name === undefined) {
    throw new AppError("VALIDATION_FAILED", "Config asset must have a name");
  }
  return name;
}

function readConfigName(config: unknown): string | undefined {
  if (typeof config !== "object" || config === null || !("name" in config)) {
    return undefined;
  }
  const name = (config as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

function findValidatedConfig(
  bundle: { agents: AgentConfig[]; skills: SkillConfig[] },
  kind: ConfigAssetKind,
  name: string
): AgentConfig | SkillConfig {
  const config = (kind === "agent" ? bundle.agents : bundle.skills).find(
    (candidate) => candidate.name === name
  );
  if (!config) {
    throw new AppError("VALIDATION_FAILED", `Validated config ${kind} '${name}' was not found`);
  }
  return config;
}

function findBundleConfig(
  bundle: ConfigAssetBundleInput,
  kind: ConfigAssetKind,
  name: string
): AgentConfig | SkillConfig | undefined {
  return (kind === "agent" ? bundle.agents : bundle.skills).find(
    (candidate) => readConfigName(candidate) === name
  ) as AgentConfig | SkillConfig | undefined;
}

/** Object key order carries no meaning: a JSON store may return keys in another order. */
function configValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(withSortedKeys(left)) === JSON.stringify(withSortedKeys(right));
}

function withSortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withSortedKeys);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, withSortedKeys(entry)])
  );
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

function shouldSetInitialDefault(bundle: ConfigAssetBundleInput, kind: ConfigAssetKind): boolean {
  return kind === "agent" && bundle.agents.length === 0 && bundle.defaultAgentName === undefined;
}

function shouldClearLastDefault(
  bundle: ConfigAssetBundleInput,
  input: { kind: ConfigAssetKind; name: string }
): boolean {
  return (
    input.kind === "agent" && bundle.agents.length === 1 && bundle.defaultAgentName === input.name
  );
}
