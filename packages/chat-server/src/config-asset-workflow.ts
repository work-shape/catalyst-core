import {
  AGENT_EDITABLE_FIELDS,
  AppError,
  auditActorFromUser,
  isJsonObject,
  requireAuthScope,
  requirePermission,
  unknownToJsonValue,
  type AgentConfig,
  type AgentEditableField,
  type AuthenticatedUser,
  type ConfigAssetKind,
  type ConfigAssetMutation,
  type ConfigAssetRecord,
  type JsonObject,
  type RuntimeCallContext,
  type SkillConfig
} from "@vivd-catalyst/core";
import { validateConfigAssetBundle } from "@vivd-catalyst/config-schema";
import { authorizeGovernanceAction } from "./governance-actions";
import type { ChatServerOptions } from "./types";

interface ConfigAssetBundleInput {
  defaultAgentName?: string;
  agents: unknown[];
  skills: unknown[];
}

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

  async getOverview(user: AuthenticatedUser, context: RuntimeCallContext) {
    await this.authorizeAuditedRead(user, context);
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
      ...(state.defaultAgentName === undefined ? {} : { defaultAgentName: state.defaultAgentName }),
      assets: assets.map((asset) => ({
        kind: asset.kind,
        name: asset.name,
        revision: asset.revision,
        updatedAt: asset.updatedAt
      })),
      references: this.options.configAssets.validationRefs
    };
  }

  async getAsset(
    user: AuthenticatedUser,
    _context: RuntimeCallContext,
    input: { kind: ConfigAssetKind; name: string }
  ) {
    this.authorizeRead(user);
    const asset = await this.getActiveAssetOrThrow(input);
    return projectConfigAsset(asset);
  }

  async putAsset(
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    command: PutConfigAssetCommand
  ) {
    await this.authorizeInteractiveWrite(user, context);
    requireMatchingConfigName(command.config, command.name);
    const current = await this.loadCurrentBundle();
    const setInitialDefault = shouldSetInitialDefault(current, command.kind);
    const replaced = replaceBundleAsset(current, command);
    const candidate = setInitialDefault
      ? { ...replaced, defaultAgentName: command.name }
      : replaced;
    const validated = this.validateBundle(candidate);
    const config = findValidatedConfig(validated, command.kind, command.name);
    this.assertInteractiveAssetUpsertAllowed({
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
    const result = await this.options.configAssets.store.applyConfigAssetMutations({
      clientInstanceId: this.options.clientInstanceId,
      baseVersion: command.baseVersion,
      actor: auditActorFromUser(user),
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
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    command: AssetMutationCommand
  ) {
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
    const result = await this.options.configAssets.store.applyConfigAssetMutations({
      clientInstanceId: this.options.clientInstanceId,
      baseVersion: command.baseVersion,
      actor: auditActorFromUser(user),
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
    user: AuthenticatedUser,
    context: RuntimeCallContext,
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
    const result = await this.options.configAssets.store.applyConfigAssetMutations({
      clientInstanceId: this.options.clientInstanceId,
      baseVersion: command.baseVersion,
      actor: auditActorFromUser(user),
      mutations: [{ type: "setDefaultAgent", agentName: command.agentName }]
    });
    await this.recordMutation(user, context, "config_asset.default_agent_set", {
      agentName: command.agentName ?? null,
      version: result.version
    });
    return result;
  }

  async listRevisions(
    user: AuthenticatedUser,
    _context: RuntimeCallContext,
    input: { kind: ConfigAssetKind; name: string }
  ) {
    this.authorizeRead(user);
    const revisions = await this.options.configAssets.store.listConfigAssetRevisions({
      clientInstanceId: this.options.clientInstanceId,
      ...input
    });
    return revisions.map((revision) => ({
      revision: revision.revision,
      operation: revision.operation,
      config: revision.config,
      actor: revision.actor,
      globalVersion: revision.globalVersion,
      createdAt: revision.createdAt
    }));
  }

  async revertAsset(
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    command: AssetMutationCommand & { revision: number }
  ) {
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
    const config = findValidatedConfig(validated, command.kind, command.name);
    this.assertInteractiveAssetUpsertAllowed({
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
    const result = await this.options.configAssets.store.applyConfigAssetMutations({
      clientInstanceId: this.options.clientInstanceId,
      baseVersion: command.baseVersion,
      actor: auditActorFromUser(user),
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

  async exportAssets(user: AuthenticatedUser, context: RuntimeCallContext) {
    await this.authorizeAuditedRead(user, context);
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
      ...(state.defaultAgentName === undefined ? {} : { defaultAgentName: state.defaultAgentName }),
      agents: assetConfigs(assets, "agent"),
      skills: assetConfigs(assets, "skill")
    };
  }

  async replaceAssets(
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    command: ConfigAssetBundleInput & { baseVersion: number | null }
  ) {
    await this.authorizeReleaseWrite(user, context);
    const validated = this.validateBundle(command);
    const currentAssets = await this.options.configAssets.store.listActiveConfigAssets({
      clientInstanceId: this.options.clientInstanceId
    });
    const desiredKeys = new Set([
      ...validated.agents.map((agent) => assetKey("agent", agent.name)),
      ...validated.skills.map((skill) => assetKey("skill", skill.name))
    ]);
    const mutations: ConfigAssetMutation[] = currentAssets
      .filter((asset) => !desiredKeys.has(assetKey(asset.kind, asset.name)))
      .map((asset) => ({ type: "delete", kind: asset.kind, name: asset.name }));
    mutations.push(
      ...validated.agents.map((agent) => ({
        type: "upsert" as const,
        kind: "agent" as const,
        name: agent.name,
        config: toJsonObject(agent)
      })),
      ...validated.skills.map((skill) => ({
        type: "upsert" as const,
        kind: "skill" as const,
        name: skill.name,
        config: toJsonObject(skill)
      })),
      { type: "setDefaultAgent", agentName: command.defaultAgentName }
    );
    const result = await this.options.configAssets.store.applyConfigAssetMutations({
      clientInstanceId: this.options.clientInstanceId,
      ...(command.baseVersion === null ? {} : { baseVersion: command.baseVersion }),
      actor: auditActorFromUser(user),
      mutations
    });
    await this.recordMutation(user, context, "config_assets.replaced", {
      version: result.version
    });
    return result;
  }

  async validateAssets(
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    command: ConfigAssetBundleInput
  ): Promise<{ valid: true }> {
    await this.authorizeReleaseWrite(user, context);
    this.validateBundle(command);
    return { valid: true };
  }

  private authorizeRead(user: AuthenticatedUser): void {
    requireAuthScope(user, "config_assets:read");
    requirePermission(user, "config_assets.read");
  }

  private async authorizeAuditedRead(
    user: AuthenticatedUser,
    context: RuntimeCallContext
  ): Promise<void> {
    requireAuthScope(user, "config_assets:read");
    await authorizeGovernanceAction({
      options: this.options,
      user,
      context,
      requiredPermission: "config_assets.read",
      auditType: "governance.config_assets_viewed",
      deniedMessage: "Config assets require 'config_assets.read' permission"
    });
  }

  private async authorizeInteractiveWrite(
    user: AuthenticatedUser,
    context: RuntimeCallContext
  ): Promise<void> {
    requireAuthScope(user, "config_assets:write");
    await authorizeGovernanceAction({
      options: this.options,
      user,
      context,
      requiredPermission: "config_assets.write",
      auditType: "governance.config_assets_write_authorized",
      deniedMessage: "Config asset changes require 'config_assets.write' permission"
    });
    if (!this.options.config.administration.agentConfiguration.enabled) {
      throw new AppError("FORBIDDEN", "Interactive agent configuration is disabled");
    }
  }

  private async authorizeReleaseWrite(
    user: AuthenticatedUser,
    context: RuntimeCallContext
  ): Promise<void> {
    requireAuthScope(user, "config_assets:release");
    await authorizeGovernanceAction({
      options: this.options,
      user,
      context,
      requiredPermission: "config_assets.release",
      auditType: "governance.config_assets_release_authorized",
      deniedMessage: "Config asset release sync requires 'config_assets.release' permission"
    });
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

  private assertInteractiveAssetUpsertAllowed(input: {
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
    const protectedFields = changedFields.filter((field) => !editableFields.has(field));
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
    return validateConfigAssetBundle({
      ...input,
      refs: this.options.configAssets.validationRefs
    });
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
    user: AuthenticatedUser,
    context: RuntimeCallContext,
    type: string,
    metadata: JsonObject
  ): Promise<void> {
    await this.options.auditRecorder.record({
      type,
      status: "success",
      actor: auditActorFromUser(user),
      correlationId: context.correlationId,
      metadata
    });
  }
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

function configValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
