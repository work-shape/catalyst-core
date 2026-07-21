import {
  AGENT_EDITABLE_FIELDS,
  AppError,
  auditActorFromIdentity,
  isJsonObject,
  requireAuthScope,
  requirePermission,
  unknownToJsonValue,
  type AgentConfig,
  type AgentEditableField,
  type AuthenticatedIdentity,
  type ConfigAssetKind,
  type ConfigAssetMutation,
  type ConfigAssetRecord,
  type JsonObject,
  type RuntimeCallContext,
  type SkillConfig
} from "@vivd-catalyst/core";
import {
  assertSpendBudgetPricingCoverage,
  validateConfigAssetBundle
} from "@vivd-catalyst/config-schema";
import { authorizeGovernanceAction } from "./governance-actions";
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
    user: AuthenticatedIdentity,
    _context: ConfigAssetCallContext,
    input: { kind: ConfigAssetKind; name: string }
  ) {
    this.authorizeRead(user);
    const asset = await this.getActiveAssetOrThrow(input);
    return projectConfigAsset(asset);
  }

  async putAsset(
    user: AuthenticatedIdentity,
    context: ConfigAssetCallContext,
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
    const result = await this.options.configAssets.store.applyConfigAssetMutations({
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

  async listRevisions(
    user: AuthenticatedIdentity,
    _context: ConfigAssetCallContext,
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
    user: AuthenticatedIdentity,
    context: ConfigAssetCallContext,
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
    user: AuthenticatedIdentity,
    context: ConfigAssetCallContext,
    command: ConfigAssetBundleInput & {
      baseVersion: number | null;
      mode?: "mirror" | "merge";
    }
  ) {
    await this.authorizeReleaseWrite(user, context);
    const [currentState, currentAssets] = await Promise.all([
      this.options.configAssets.store.getConfigAssetState({
        clientInstanceId: this.options.clientInstanceId
      }),
      this.options.configAssets.store.listActiveConfigAssets({
        clientInstanceId: this.options.clientInstanceId
      })
    ]);
    const merge = command.mode === "merge";
    const candidate = merge
      ? mergeBundle(assetBundle(currentAssets, currentState.defaultAgentName), command)
      : command;
    const validated = this.validateBundle(candidate);
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
      ...validated.agents.filter((agent) => providedAgentNames.has(agent.name)).map((agent) => ({
        type: "upsert" as const,
        kind: "agent" as const,
        name: agent.name,
        config: toJsonObject(agent)
      })),
      ...validated.skills.filter((skill) => providedSkillNames.has(skill.name)).map((skill) => ({
        type: "upsert" as const,
        kind: "skill" as const,
        name: skill.name,
        config: toJsonObject(skill)
      }))
    );
    if (!merge || command.defaultAgentName !== undefined) {
      mutations.push({ type: "setDefaultAgent", agentName: command.defaultAgentName });
    }
    const result = await this.options.configAssets.store.applyConfigAssetMutations({
      clientInstanceId: this.options.clientInstanceId,
      ...(command.baseVersion === null ? {} : { baseVersion: command.baseVersion }),
      actor: auditActorFromIdentity(user),
      mutations
    });
    await this.recordMutation(user, context, "config_assets.replaced", {
      version: result.version
    });
    return result;
  }

  async validateAssets(
    user: AuthenticatedIdentity,
    context: ConfigAssetCallContext,
    command: ConfigAssetBundleInput
  ): Promise<{ valid: true }> {
    await this.authorizeReleaseWrite(user, context);
    this.validateBundle(command);
    return { valid: true };
  }

  private authorizeRead(user: AuthenticatedIdentity): void {
    requireAuthScope(user, "config_assets:read");
    requirePermission(user, "config_assets.read");
  }

  private async authorizeAuditedRead(
    user: AuthenticatedIdentity,
    context: ConfigAssetCallContext
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
    user: AuthenticatedIdentity,
    context: ConfigAssetCallContext
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
    user: AuthenticatedIdentity,
    context: ConfigAssetCallContext
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
    const validated = validateConfigAssetBundle({
      ...input,
      refs: this.options.configAssets.validationRefs
    });
    assertSpendBudgetPricingCoverage(this.options.config, validated.agents);
    const issues = this.options.configAssets.validateAgents?.(validated.agents) ?? [];
    if (issues.length > 0) {
      throw new AppError("VALIDATION_FAILED", "Config asset bundle is invalid", {
        issues: issues.map((message) => ({ message }))
      });
    }
    return validated;
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
