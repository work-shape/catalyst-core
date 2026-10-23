import {
  AppError,
  INSTANCE_ASSET_SCOPE,
  asCollaborationWorkspaceId,
  asUserId,
  auditActorFromIdentity,
  isAuthenticatedServicePrincipal,
  type AccessResource,
  type ActorAccess,
  type AgentAvailability,
  type AgentUse,
  type CollaborationWorkspace,
  type InitialAgentAvailability,
  type JsonObject,
  type OperationAuthorization
} from "@work-shape/catalyst-core";
import {
  makeAgentDependenciesAvailable,
  agentDependencyWarnings
} from "./agent-dependency-availability";
import type { WorkflowAssetKind } from "../asset-kinds/shared";
import { accessResource, decide, transactionalAssetCall, type AssetCall } from "./asset-access";
import { validateAssetSet, withDefaultAgentName } from "./asset-set";
import {
  authorizeInteractiveWrite,
  loadStoredAssets,
  requireAssetKindModuleOn
} from "./asset-write-rules";
import { applyValidatedConfigAssetMutations } from "./config-asset-writer";
import type { AssetWorkflowOptions } from "../types";

/**
 * Where an asset stands on the instance beside its content: whether it is the default of its
 * kind, and the workspaces it is offered in. Both belong to the instance as a whole, so the
 * right is the kind's write right on the whole instance. A grant in a workspace or on one
 * asset does not answer it, and a deny on the named asset still refuses.
 */

interface SetAssetDefaultInput {
  kind: string;
  /** The asset that becomes the default, or `null` for none. */
  name: string | null;
  /** The id of the named asset as the caller read it. */
  expectedAssetId?: string;
}

interface SetAssetAvailabilityInput {
  expectedRevision?: number;
  makeDependenciesAvailable?: boolean;
  kind: string;
  name: string;
  mode: AgentAvailability["mode"];
  personalWorkspaces?: boolean;
  collaborationWorkspaceIds?: string[];
  /** What the change was decided against. The store compares both under its lock. */
  expectedAssetId?: string;
  expectedAvailability?: {
    mode: AgentAvailability["mode"];
    personalWorkspaces: boolean;
    collaborationWorkspaceIds: string[];
  } | null;
}

export async function authorizeAssetPlacement(
  options: AssetWorkflowOptions,
  access: ActorAccess,
  input: { kind: string; name: string | null }
): Promise<OperationAuthorization> {
  const kind = kindOf(options, input.kind);
  // Asked without a resource, so only an entry at instance scope answers.
  const instanceWide = access.authorize(kind.actions.write);
  if (!instanceWide.allowed) {
    return { allowed: false, action: kind.actions.write, reason: instanceWide.reason };
  }
  const named = await namedResource(options, kind, input.name);
  return named ? decide(access, kind.actions.write, named) : { allowed: true };
}

/** Makes one asset the instance's default of its kind, or leaves the instance without one. */
export async function setAssetDefault(
  options: AssetWorkflowOptions,
  call: AssetCall,
  input: SetAssetDefaultInput
): Promise<{ version: number }> {
  const kind = kindOf(options, input.kind);
  await requirePlacementRight(options, call, input);
  if (!kind.holdsInstanceDefault) {
    throw new AppError("VALIDATION_FAILED", `Asset kind '${kind.kind}' keeps no default`);
  }
  await authorizeInteractiveWrite(options, call.actor, call, call.audit);
  if (!options.config.administration.agentConfiguration.allowDefaultAgentChange) {
    throw new AppError("FORBIDDEN", "Interactive default-agent changes are disabled");
  }
  const name = input.name ?? undefined;
  await requireExpectedAsset(options, kind, input);
  const stored = await loadStoredAssets(options);
  validateAssetSet(
    options.configAssets.kinds.kinds,
    withDefaultAgentName(stored.set, name),
    stored.set
  );
  const result = await applyValidatedConfigAssetMutations(options, {
    clientInstanceId: options.clientInstanceId,
    actor: auditActorFromIdentity(call.actor),
    // No asset gets a revision here, so there is none to name.
    baseRevisions: {},
    mutations: [{ type: "setDefaultAgent", agentName: name }]
  });
  await recordPlacement(call, "config_asset.default_agent_set", {
    agentName: input.name,
    version: result.version
  });
  return { version: result.version };
}

/** Sets the workspaces one asset is offered in. The next run that starts reads them. */
export async function setAssetAvailability(
  options: AssetWorkflowOptions,
  call: AssetCall,
  input: SetAssetAvailabilityInput
): Promise<AgentAvailability> {
  const kind = kindOf(options, input.kind);
  await requirePlacementRight(options, call, input);
  if (!kind.hasWorkspaceAvailability) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Asset kind '${kind.kind}' is not offered per workspace`
    );
  }
  await authorizeInteractiveWrite(options, call.actor, call, call.audit);
  if (input.kind === "agent" && input.makeDependenciesAvailable) {
    if (input.expectedRevision === undefined)
      throw new AppError(
        "PRECONDITION_REQUIRED",
        "Read the agent again before changing its dependencies' availability"
      );
    return options.stores.transaction(async (stores) => {
      const within = {
        ...options,
        stores,
        configAssets: { ...options.configAssets, store: stores.configAssets }
      };
      const asset = await stores.configAssets.getConfigAsset({
        clientInstanceId: options.clientInstanceId,
        kind: "agent",
        name: input.name
      });
      const wanted: AgentAvailability = {
        mode: input.mode,
        personalWorkspaces: input.mode === "selected" && input.personalWorkspaces === true,
        collaborationWorkspaceIds:
          input.mode === "selected"
            ? (input.collaborationWorkspaceIds ?? []).map(asCollaborationWorkspaceId)
            : []
      };
      await makeAgentDependenciesAvailable(within, call, asset?.config, wanted);
      return setAssetAvailability(
        within,
        transactionalAssetCall(call, options.clientInstanceId, stores.audit),
        { ...input, makeDependenciesAvailable: false }
      );
    });
  }
  const selected = input.mode === "selected";
  const collaborationWorkspaceIds = selected
    ? (input.collaborationWorkspaceIds ?? []).map(asCollaborationWorkspaceId)
    : [];
  for (const collaborationWorkspaceId of collaborationWorkspaceIds) {
    const workspace = await options.stores.workspaces.getWorkspace(
      options.clientInstanceId,
      collaborationWorkspaceId
    );
    if (workspace?.kind !== "shared") {
      throw new AppError(
        "VALIDATION_FAILED",
        `'${collaborationWorkspaceId}' is not a Shared Workspace of this client instance`
      );
    }
  }
  const availability = await options.configAssets.store.setAgentAvailability({
    clientInstanceId: options.clientInstanceId,
    agentName: input.name,
    kind: input.kind,
    ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
    availability: {
      mode: input.mode,
      personalWorkspaces: selected && input.personalWorkspaces === true,
      collaborationWorkspaceIds
    },
    ...(input.expectedAssetId === undefined ? {} : { expectedAssetId: input.expectedAssetId }),
    ...(input.expectedAvailability === undefined
      ? {}
      : {
          expectedAvailability:
            input.expectedAvailability === null
              ? null
              : {
                  ...input.expectedAvailability,
                  collaborationWorkspaceIds:
                    input.expectedAvailability.collaborationWorkspaceIds.map(
                      asCollaborationWorkspaceId
                    )
                }
        })
  });
  await recordPlacement(call, "config_asset.availability_set", {
    kind: kind.kind,
    name: input.name,
    mode: availability.mode,
    personalWorkspaces: availability.personalWorkspaces,
    collaborationWorkspaceIds: availability.collaborationWorkspaceIds
  });
  return availability;
}

/**
 * Who uses one agent where it is available (AGENT-USE-1): everyone who may work there, or only
 * holders of `agent.use` on it. It is decided like its availability and read by the next start.
 */
export async function setAgentUse(
  options: AssetWorkflowOptions,
  call: AssetCall,
  input: { name: string; use: AgentUse; expectedAssetId?: string }
): Promise<{ use: AgentUse }> {
  await requirePlacementRight(options, call, { kind: "agent", name: input.name });
  await authorizeInteractiveWrite(options, call.actor, call, call.audit);
  const [before, asset] = await Promise.all([
    options.configAssets.store.listAgentUseLimits({
      clientInstanceId: options.clientInstanceId,
      agentName: input.name
    }),
    options.configAssets.store.getConfigAsset({
      clientInstanceId: options.clientInstanceId,
      kind: "agent",
      name: input.name
    })
  ]);
  const use = await options.configAssets.store.setAgentUse({
    clientInstanceId: options.clientInstanceId,
    agentName: input.name,
    use: input.use,
    ...(input.expectedAssetId === undefined ? {} : { expectedAssetId: input.expectedAssetId })
  });
  await recordPlacement(call, "config_asset.use_set", {
    kind: "agent",
    name: input.name,
    ...(asset ? { agentId: asset.id } : {}),
    before: before.has(input.name) ? "granted" : "everyone",
    use
  });
  return { use };
}

/**
 * Where a write asks a new agent to start: everywhere, in the shared workspace it names, or
 * nowhere. The API offers the first two; `nowhere` is the agent's own first save in a
 * conversation, whose agent waits for a person to make it available (NAV-2).
 */
export type AvailableIn = "all" | "nowhere" | { workspaceId: string };

/** What a write did that its caller should know and that did not refuse it. */
export interface AssetWarning {
  code: string;
  message: string;
}

/**
 * Where an agent that a put or a revert creates starts. It is available in the shared
 * workspace it is made in and nowhere else: the one the write names, else the workspace that
 * owns it, else the conversation's. Made in no shared workspace, such as a personal
 * one or by the CLI, or by someone without `agent.approve` in the workspace that owns it, it
 * is hidden, and the caller is warned. Wider is an instance admin's
 * step: `all` here, a workspace other than the one that owns the agent, or the availability
 * later. The instance's first agent becomes its default, which every workspace offers; a
 * workspace's agent never does.
 */
export async function initialAgentPlacement(
  options: AssetWorkflowOptions,
  call: AssetCall,
  kind: WorkflowAssetKind,
  input: {
    name: string;
    creates: boolean;
    setsDefault: boolean;
    config: unknown;
    availableIn?: AvailableIn;
    /** The workspace that owns the agent, which it is made in unless the write names one. */
    madeIn?: string;
  }
): Promise<{ initialAgentAvailability?: InitialAgentAvailability; warnings: AssetWarning[] }> {
  // Knowledge Bases and Connections start with no availability. Their use is widened only
  // by an explicit availability save, never by an ordinary content write or release.
  if (kind.kind !== "agent") {
    if (input.availableIn !== undefined && input.availableIn !== "nowhere")
      throw new AppError(
        "VALIDATION_FAILED",
        "Set this asset's availability with assets.set_availability"
      );
    return { warnings: [] };
  }
  if (!kind.hasWorkspaceAvailability || !input.creates) {
    if (input.availableIn !== undefined) {
      throw new AppError(
        "VALIDATION_FAILED",
        kind.hasWorkspaceAvailability
          ? `Config ${kind.kind} '${input.name}' exists: its availability is set on its own`
          : `Asset kind '${kind.kind}' is not offered per workspace`,
        { reason: "available_in_not_taken" }
      );
    }
    return { warnings: [] };
  }
  if (input.setsDefault) {
    return {
      initialAgentAvailability: "all",
      warnings: await agentDependencyWarnings(options, call, input.config, {
        mode: "all",
        personalWorkspaces: false,
        collaborationWorkspaceIds: []
      })
    };
  }
  if (input.availableIn === "nowhere") {
    return { initialAgentAvailability: "hidden", warnings: [] };
  }
  if (input.availableIn === "all") {
    // Asked without a resource, so only an entry at instance scope answers.
    call.access.require(kind.actions.write);
    return {
      initialAgentAvailability: "all",
      warnings: await agentDependencyWarnings(options, call, input.config, {
        mode: "all",
        personalWorkspaces: false,
        collaborationWorkspaceIds: []
      })
    };
  }
  const named = input.availableIn?.workspaceId;
  if (named !== undefined && input.madeIn !== undefined && named !== input.madeIn) {
    // A workspace's agent starts in its own workspace. Offering it in another is an instance
    // admin's step, as widening it later is: asked without a resource, so only an entry at
    // instance scope answers.
    call.access.require(kind.actions.write);
  }
  if (
    input.madeIn !== undefined &&
    kind.actions.approve !== undefined &&
    !call.access.authorize(kind.actions.approve, { kind: kind.kind, workspaceId: input.madeIn })
      .allowed
  ) {
    // A workspace's agent made by someone who may not approve its publish starts offered
    // nowhere, whoever made it and however: its first publish, once approved, offers it in its
    // workspace (WS-PUB-1b, access check 11).
    return {
      initialAgentAvailability: "hidden",
      warnings: [
        {
          code: "agent_hidden",
          message: `Agent '${input.name}' is offered in its workspace once its first publish is approved`
        }
      ]
    };
  }
  const workspace = await memberWorkspace(options, call, named ?? input.madeIn ?? call.workspaceId);
  if (named !== undefined && !workspace) {
    throw new AppError(
      "VALIDATION_FAILED",
      `'${named}' is no workspace of this client instance that the caller is a member of`,
      { reason: "workspace_not_found" }
    );
  }
  if (workspace?.kind === "shared") {
    return { initialAgentAvailability: { collaborationWorkspaceId: workspace.id }, warnings: [] };
  }
  return {
    initialAgentAvailability: "hidden",
    warnings: [
      {
        code: "agent_hidden",
        message: `Agent '${input.name}' is hidden until an instance admin makes it available`
      }
    ]
  };
}

/** The workspace of that id, where the caller is a person who is one of its members. */
async function memberWorkspace(
  options: AssetWorkflowOptions,
  call: AssetCall,
  workspaceId: string | undefined
): Promise<CollaborationWorkspace | undefined> {
  if (workspaceId === undefined || isAuthenticatedServicePrincipal(call.actor)) return undefined;
  const collaborationWorkspaceId = asCollaborationWorkspaceId(workspaceId);
  const [workspace, membership] = await Promise.all([
    options.stores.workspaces.getWorkspace(options.clientInstanceId, collaborationWorkspaceId),
    options.stores.workspaces.getMembership({
      clientInstanceId: options.clientInstanceId,
      collaborationWorkspaceId,
      userId: asUserId(call.actor.id)
    })
  ]);
  return membership ? workspace : undefined;
}

/** A kind of a module that is off does not exist here, whatever the store still holds. */
function kindOf(options: AssetWorkflowOptions, kind: string): WorkflowAssetKind {
  requireAssetKindModuleOn(options.modules, kind);
  return options.configAssets.kinds.require(kind);
}

/**
 * Refuses a change of the default that was made for another asset than the one that holds
 * the name now: a call that waited for an approval runs against what is stored then.
 */
async function requireExpectedAsset(
  options: AssetWorkflowOptions,
  kind: WorkflowAssetKind,
  input: SetAssetDefaultInput
): Promise<void> {
  if (input.name === null || input.expectedAssetId === undefined) return;
  const row = await options.configAssets.store.getConfigAsset({
    clientInstanceId: options.clientInstanceId,
    kind: kind.kind,
    name: input.name
  });
  if (row?.id !== input.expectedAssetId) {
    throw new AppError(
      "CONFLICT",
      `Config ${kind.kind} '${input.name}' is another asset than the one this change was made for`,
      { kind: kind.kind, name: input.name, reason: "asset_replaced" }
    );
  }
}

/** The right once more, on what the store holds when the call runs. */
async function requirePlacementRight(
  options: AssetWorkflowOptions,
  call: AssetCall,
  input: { kind: string; name: string | null }
): Promise<void> {
  const kind = kindOf(options, input.kind);
  call.access.require(kind.actions.write);
  const named = await namedResource(options, kind, input.name);
  if (named) {
    call.access.require(kind.actions.write, named);
  }
}

/**
 * The asset a call names, as a deny on it is found: with its owner and its id, so a deny on
 * the asset or on the workspace that owns it refuses. The default and the availability are
 * the instance's whoever owns the asset, so the right is still the kind's write right on the
 * whole instance.
 */
async function namedResource(
  options: AssetWorkflowOptions,
  kind: WorkflowAssetKind,
  name: string | null
): Promise<AccessResource | undefined> {
  if (name === null) return undefined;
  const row = await options.configAssets.store.getConfigAsset({
    clientInstanceId: options.clientInstanceId,
    kind: kind.kind,
    name
  });
  return accessResource(kind.kind, name, row?.scope ?? INSTANCE_ASSET_SCOPE, row?.id);
}

async function recordPlacement(call: AssetCall, type: string, metadata: JsonObject): Promise<void> {
  // The recorder of the Operation Run: the row names the run that wrote it. It is named as
  // the event registry's test finds a recorder, so the two names count as emitted.
  const auditRecorder = call.audit;
  await auditRecorder.record({
    type,
    status: "success",
    actor: auditActorFromIdentity(call.actor),
    correlationId: call.correlationId,
    metadata
  });
}
