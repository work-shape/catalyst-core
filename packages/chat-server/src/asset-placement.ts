import {
  AppError,
  INSTANCE_ASSET_SCOPE,
  asCollaborationWorkspaceId,
  assetScopesEqual,
  auditActorFromIdentity,
  type AccessResource,
  type ActorAccess,
  type AgentAvailability,
  type JsonObject,
  type OperationAuthorization
} from "@vivd-catalyst/core";
import type { WorkflowAssetKind } from "./asset-kinds/shared";
import { accessResource, decide, type AssetCall } from "./asset-access";
import { validateAssetSet, withDefaultAgentName } from "./asset-set";
import {
  authorizeInteractiveWrite,
  loadStoredAssets,
  requireAssetKindModuleOn
} from "./asset-write-rules";
import { applyValidatedConfigAssetMutations } from "./config-asset-writer";
import type { ChatServerOptions } from "./types";

/**
 * Where an asset stands on the instance beside its content: whether it is the default of its
 * kind, and the workspaces it is offered in. Both belong to the instance as a whole, so the
 * right is the kind's write right on the whole instance. A grant in a Namespace or on one
 * asset does not answer it, and a deny on the named asset still refuses.
 */

interface SetAssetDefaultInput {
  kind: string;
  /** The asset that becomes the default, or `null` for none. */
  name: string | null;
}

interface SetAssetAvailabilityInput {
  kind: string;
  name: string;
  mode: AgentAvailability["mode"];
  personalWorkspaces?: boolean;
  collaborationWorkspaceIds?: string[];
}

export async function authorizeAssetPlacement(
  options: ChatServerOptions,
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
  options: ChatServerOptions,
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
  const stored = await loadStoredAssets(options);
  validateAssetSet(
    options.configAssets.kinds.kinds,
    withDefaultAgentName(stored.set, name),
    stored.set
  );
  const result = await applyValidatedConfigAssetMutations(options, {
    clientInstanceId: options.clientInstanceId,
    actor: auditActorFromIdentity(call.actor),
    mutations: [{ type: "setDefaultAgent", agentName: name }]
  });
  await record(call, "config_asset.default_agent_set", {
    agentName: input.name,
    version: result.version
  });
  return result;
}

/** Sets the workspaces one asset is offered in. The next run that starts reads them. */
export async function setAssetAvailability(
  options: ChatServerOptions,
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
    availability: {
      mode: input.mode,
      personalWorkspaces: selected && input.personalWorkspaces === true,
      collaborationWorkspaceIds
    }
  });
  await record(call, "config_asset.availability_set", {
    kind: kind.kind,
    name: input.name,
    mode: availability.mode,
    personalWorkspaces: availability.personalWorkspaces,
    collaborationWorkspaceIds: availability.collaborationWorkspaceIds
  });
  return availability;
}

/** A kind of a module that is off does not exist here, whatever the store still holds. */
function kindOf(options: ChatServerOptions, kind: string): WorkflowAssetKind {
  requireAssetKindModuleOn(options.modules, kind);
  return options.configAssets.kinds.require(kind);
}

/** The right once more, on what the store holds when the call runs. */
async function requirePlacementRight(
  options: ChatServerOptions,
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
 * The asset a call names, as a deny on it is found. Only an asset of the instance has a
 * default or an availability: the id of a row another owner holds is no part of it.
 */
async function namedResource(
  options: ChatServerOptions,
  kind: WorkflowAssetKind,
  name: string | null
): Promise<AccessResource | undefined> {
  if (name === null) return undefined;
  const row = await options.configAssets.store.getConfigAsset({
    clientInstanceId: options.clientInstanceId,
    kind: kind.kind,
    name
  });
  const assetId = row && assetScopesEqual(row.scope, INSTANCE_ASSET_SCOPE) ? row.id : undefined;
  return accessResource(kind.kind, name, INSTANCE_ASSET_SCOPE, assetId);
}

async function record(call: AssetCall, type: string, metadata: JsonObject): Promise<void> {
  // The recorder of the Operation Run: the row names the run that wrote it.
  await call.audit.record({
    type,
    status: "success",
    actor: auditActorFromIdentity(call.actor),
    correlationId: call.correlationId,
    metadata
  });
}
