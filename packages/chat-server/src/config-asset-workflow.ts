import {
  AppError,
  asCollaborationWorkspaceId,
  assertConfigAssetBases,
  type AgentAvailability,
  type ConfigAssetRevisionRecord,
  auditActorFromIdentity,
  type ActorAccess,
  type AuthenticatedIdentity,
  type ConfigAssetKind,
  type ConfigAssetMutation,
  type ConfigAssetRecord,
  type JsonObject,
  type RuntimeCallContext
} from "@vivd-catalyst/core";
import {
  readDefinitionName,
  type ConfigAssetBundle,
  type WorkflowAssetKind
} from "./asset-kinds/shared";
import {
  assetSetOfBundle,
  definitionsOf,
  validateAssetSet,
  withDefaultAgentName,
  withoutDefinition,
  type AssetSet
} from "./asset-set";
import {
  assertChangedAgentsAllowed,
  assetKey,
  authorizeInteractiveWrite,
  loadStoredAssets,
  requireConfigName,
  toJsonObject
} from "./asset-write-rules";
import { applyValidatedConfigAssetMutations } from "./config-asset-writer";
import { recordGovernanceAccess } from "./governance-actions";
import type { ChatServerOptions } from "./types";

type ConfigAssetBundleInput = ConfigAssetBundle;

type ConfigAssetCallContext = Pick<RuntimeCallContext, "correlationId">;

/**
 * What the instance's set of agents and skills is read and replaced through as a whole: the
 * overview, the default agent, an agent's availability, and the release sync's export, check
 * and import. One asset is read and written through the asset operations.
 */
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
      // The overview is the bundle's view of the instance: the kinds a release carries.
      assets: assets
        .filter(({ kind }) => this.kinds.get(kind)?.bundle !== undefined)
        .map((asset) => ({
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
        ),
        // An agent that still names one shows it as unavailable and can drop it.
        moduleOffTools: refs.enabledToolNames.flatMap((name) => {
          const module = this.options.modules.offModuleOf("tool", name);
          return module === undefined ? [] : [{ name, module }];
        })
      }
    };
  }

  async setDefaultAgent(
    user: AuthenticatedIdentity,
    context: ConfigAssetCallContext,
    command: { agentName?: string; baseVersion?: number }
  ) {
    await authorizeInteractiveWrite(this.options, user, context);
    if (!this.options.config.administration.agentConfiguration.allowDefaultAgentChange) {
      throw new AppError("FORBIDDEN", "Interactive default-agent changes are disabled");
    }
    const stored = await loadStoredAssets(this.options);
    validateAssetSet(
      this.kinds.kinds,
      withDefaultAgentName(stored.set, command.agentName),
      stored.set
    );
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
    await authorizeInteractiveWrite(this.options, user, context);
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

  async exportAssets(user: AuthenticatedIdentity, context: ConfigAssetCallContext) {
    await this.recordAccess(user, context, "governance.config_assets_viewed");
    const { state, assets } = await loadStoredAssets(this.options);
    const carried = assets.filter(({ kind }) => this.kinds.get(kind)?.bundle !== undefined);
    return {
      version: state.version,
      perAssetConcurrency: true as const,
      revisions: Object.fromEntries(
        carried.map((asset) => [assetKey(asset.kind, asset.name), asset.revision])
      ),
      ...assetBundle(this.kinds.kinds, carried, state.defaultAgentName)
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
    const stored = await loadStoredAssets(this.options);
    const merge = command.mode === "merge";
    const kinds = this.kinds.kinds;
    // A kind the bundle has no slot for is not the release sync's: it stays as it is stored.
    // The same holds for an asset a workspace owns: a release mirrors the instance's own.
    let candidate = merge
      ? mergeIntoSet(kinds, stored.set, command)
      : withWorkspaceOwned(assetSetOfBundle(kinds, command, stored.set), stored.assets);
    for (const asset of command.deleteAssets ?? []) {
      candidate = withoutDefinition(candidate, this.kind(asset.kind).kind, asset.name);
    }
    const provided = kinds.flatMap((kind) =>
      kind.bundle
        ? [{ kind, names: new Set(kind.bundle.definitions(command).map(readDefinitionName)) }]
        : []
    );
    if (command.baseDefaultAgentName !== undefined) {
      candidate = withDefaultAgentName(candidate, command.defaultAgentName);
    }
    if (command.baseRevisions !== undefined) {
      const kept = assetKeysOf(candidate);
      const touched = [
        ...kinds.flatMap((kind) =>
          (kind.bundle?.definitions(command) ?? []).map((config) => ({
            kind: kind.kind,
            name: requireConfigName(config)
          }))
        ),
        ...(command.deleteAssets ?? []),
        ...(!merge
          ? stored.assets.filter((asset) => !kept.has(assetKey(asset.kind, asset.name)))
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
        stored.state,
        current
      );
    }
    const validated = validateAssetSet(kinds, candidate, stored.set);
    await assertChangedAgentsAllowed(this.options, access, stored.set, validated);
    /** What the caller sent of one kind, as validated. */
    const providedDefinitions = ({ kind, names }: (typeof provided)[number]) =>
      definitionsOf(validated, kind.kind).flatMap((config) => {
        const name = readDefinitionName(config);
        return name !== undefined && names.has(name) ? [{ name, config }] : [];
      });
    const desiredKeys = assetKeysOf(validated);
    const mutations: ConfigAssetMutation[] = merge
      ? []
      : stored.assets
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
    const stored = await loadStoredAssets(this.options);
    const validated = validateAssetSet(
      this.kinds.kinds,
      assetSetOfBundle(this.kinds.kinds, command, stored.set),
      stored.set
    );
    await assertChangedAgentsAllowed(this.options, access, stored.set, validated);
    return { valid: true };
  }

  private get kinds() {
    return this.options.configAssets.kinds;
  }

  private kind(kind: string): WorkflowAssetKind {
    return this.kinds.require(kind);
  }

  private recordAccess(
    user: AuthenticatedIdentity,
    context: ConfigAssetCallContext,
    auditType: string
  ): Promise<void> {
    return recordGovernanceAccess({ options: this.options, user, context, auditType });
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

function assetBundle(
  kinds: readonly WorkflowAssetKind[],
  assets: ConfigAssetRecord[],
  defaultAgentName?: string
): ConfigAssetBundle<JsonObject> {
  return kinds.reduce<ConfigAssetBundle<JsonObject>>(
    (bundle, kind) =>
      kind.bundle?.withDefinitions(
        bundle,
        assets.flatMap((asset) =>
          asset.kind === kind.kind && asset.config !== null ? [asset.config] : []
        )
      ) ?? bundle,
    { ...(defaultAgentName === undefined ? {} : { defaultAgentName }), agents: [], skills: [] }
  );
}

/** The stored set with what a bundle carries put over it, name by name. */
function mergeIntoSet(
  kinds: readonly WorkflowAssetKind[],
  stored: AssetSet,
  incoming: ConfigAssetBundleInput
): AssetSet {
  const definitions = new Map(stored.definitions);
  for (const kind of kinds) {
    if (!kind.bundle) continue;
    const sent = kind.bundle.definitions(incoming);
    const sentNames = new Set(sent.map(readDefinitionName));
    definitions.set(kind.kind, [
      ...definitionsOf(stored, kind.kind).filter(
        (config) => !sentNames.has(readDefinitionName(config))
      ),
      ...sent
    ]);
  }
  return withDefaultAgentName(
    { definitions },
    incoming.defaultAgentName ?? stored.defaultAgentName
  );
}

/** Puts back the definitions workspaces own, where the set does not carry their name. */
function withWorkspaceOwned(set: AssetSet, stored: readonly ConfigAssetRecord[]): AssetSet {
  const owned = stored.filter((asset) => asset.scope.kind === "workspace" && asset.config !== null);
  if (owned.length === 0) return set;
  const carried = assetKeysOf(set);
  const definitions = new Map(set.definitions);
  for (const asset of owned) {
    if (carried.has(assetKey(asset.kind, asset.name))) continue;
    definitions.set(asset.kind, [...(definitions.get(asset.kind) ?? []), asset.config]);
  }
  return { ...set, definitions };
}

function assetKeysOf(set: AssetSet): Set<string> {
  return new Set(
    [...set.definitions].flatMap(([kind, definitions]) =>
      definitions.map((config) => assetKey(kind, requireConfigName(config)))
    )
  );
}
