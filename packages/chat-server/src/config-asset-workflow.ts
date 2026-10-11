import {
  AppError,
  asCollaborationWorkspaceId,
  type AgentAvailability,
  auditActorFromIdentity,
  type AuthenticatedIdentity,
  type JsonObject,
  type RuntimeCallContext
} from "@vivd-catalyst/core";
import type { WorkflowAssetKind } from "./asset-kinds/shared";
import { validateAssetSet, withDefaultAgentName } from "./asset-set";
import { authorizeInteractiveWrite, loadStoredAssets } from "./asset-write-rules";
import { applyValidatedConfigAssetMutations } from "./config-asset-writer";
import { recordGovernanceAccess } from "./governance-actions";
import type { ChatServerOptions } from "./types";

type ConfigAssetCallContext = Pick<RuntimeCallContext, "correlationId">;

/**
 * What is read and set of the instance's agents and skills as a whole: the overview, the
 * default agent and an agent's availability. Assets are read and written through the asset
 * operations, a release included.
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
    return {
      version: state.version,
      ...(state.defaultAgentName === undefined ? {} : { defaultAgentName: state.defaultAgentName }),
      // The overview shows the kinds a release carries.
      assets: assets
        .filter(({ kind }) => this.kinds.get(kind)?.inRelease === true)
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
      references: configAssetReferences(this.options)
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

/**
 * What a definition may refer to on this instance. It is read from the release config and the
 * module switches alone, so it costs no store read.
 */
export function configAssetReferences(
  options: Pick<ChatServerOptions, "configAssets" | "modules">
) {
  const refs = options.configAssets.validationRefs;
  return {
    ...refs,
    // A tool of a module that is off is not offered for an agent.
    enabledToolNames: refs.enabledToolNames.filter(
      (toolName) => options.modules.offModuleOf("tool", toolName) === undefined
    ),
    // An agent that still names one shows it as unavailable and can drop it.
    moduleOffTools: refs.enabledToolNames.flatMap((name) => {
      const module = options.modules.offModuleOf("tool", name);
      return module === undefined ? [] : [{ name, module }];
    })
  };
}
