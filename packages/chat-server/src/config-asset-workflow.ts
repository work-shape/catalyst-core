import type { AuthenticatedIdentity, RuntimeCallContext } from "@vivd-catalyst/core";
import type { WorkflowAssetKind } from "./asset-kinds/shared";
import { recordGovernanceAccess } from "./governance-actions";
import type { ChatServerOptions } from "./types";

type ConfigAssetCallContext = Pick<RuntimeCallContext, "correlationId">;

/**
 * What is read of the instance's agents and skills as a whole: the overview, and the Shared
 * Workspaces an agent can be offered in. Every write of an asset, its content, its default and
 * its audience, is an asset operation.
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
}

/**
 * What a definition may refer to on this instance. It is read from the release config and the
 * module switches alone, so it costs no store read.
 */
export function configAssetReferences(
  options: Pick<ChatServerOptions, "configAssets" | "modules">
) {
  const refs = options.configAssets.validationRefs;
  const { platformInstructions } = options.configAssets;
  // A tool of a module that is off is not offered for an agent.
  const enabledToolNames = refs.enabledToolNames.filter(
    (toolName) => options.modules.offModuleOf("tool", toolName) === undefined
  );
  const unavailableTools = refs.enabledToolNames.flatMap((name) => {
    const module = options.modules.offModuleOf("tool", name);
    return module === undefined ? [] : [{ name, module, reason: "module_off" as const }];
  });
  return {
    ...refs,
    // Shown read-only on an agent's page, as the agent gets them.
    ...(platformInstructions
      ? {
          platformInstructions: {
            ...platformInstructions,
            toolNames: [...platformInstructions.toolNames]
          }
        }
      : {}),
    enabledToolNames,
    tools: offeredToolReferences(options, enabledToolNames),
    unavailableTools,
    // Compatibility for the agent editor until it consumes unavailableTools.
    moduleOffTools: unavailableTools.map(({ name, module }) => ({ name, module }))
  };
}

/**
 * The offered tools with what each tells people and the module whose switch governs it, in the
 * order of `enabledToolNames`. A tool nothing describes is listed by its name alone.
 */
function offeredToolReferences(
  options: Pick<ChatServerOptions, "configAssets" | "modules">,
  enabledToolNames: readonly string[]
) {
  const described = new Map(
    (options.configAssets.tools?.() ?? []).map((tool) => [tool.name, tool])
  );
  return enabledToolNames.map((name) => {
    const module = options.modules.modules.find((state) =>
      state.definition?.tools?.includes(name)
    )?.name;
    return { ...described.get(name), name, ...(module === undefined ? {} : { module }) };
  });
}
