import type { Asset } from "@work-shape/catalyst-api-contract";
import { agentConfigSchema } from "@work-shape/catalyst-config-schema";
import {
  AppError,
  operationDenialError,
  auditActorFromIdentity,
  parseConnectionOperationName,
  type AgentAvailability,
  type WorkspaceUseAssetKind,
  type ActorAccess,
  type OperationAuthorization,
  type ConfigAssetRecord
} from "@work-shape/catalyst-core";
import type { AssetWorkflowOptions } from "../types";
import { accessResource, type AssetCall } from "./asset-access";

interface MissingDependency {
  kind: WorkspaceUseAssetKind;
  name: string;
  displayName: string;
  canMakeAvailable: boolean;
}

/** No availability record means nowhere, including after an upgrade. */
function availabilityCovers(
  current: AgentAvailability | undefined,
  wanted: AgentAvailability | undefined
): boolean {
  if (
    !wanted ||
    (wanted.mode === "selected" &&
      !wanted.personalWorkspaces &&
      wanted.collaborationWorkspaceIds.length === 0)
  )
    return true;
  if (current?.mode === "all") return true;
  return (
    current !== undefined &&
    wanted.mode === "selected" &&
    (!wanted.personalWorkspaces || current.personalWorkspaces) &&
    wanted.collaborationWorkspaceIds.every((id) => current.collaborationWorkspaceIds.includes(id))
  );
}

function unionAvailability(
  current: AgentAvailability | undefined,
  wanted: AgentAvailability
): AgentAvailability {
  if (current?.mode === "all" || wanted.mode === "all")
    return { mode: "all", personalWorkspaces: false, collaborationWorkspaceIds: [] };
  return {
    mode: "selected",
    personalWorkspaces: current?.personalWorkspaces === true || wanted.personalWorkspaces,
    collaborationWorkspaceIds: [
      ...new Set([
        ...(current?.collaborationWorkspaceIds ?? []),
        ...wanted.collaborationWorkspaceIds
      ])
    ]
  };
}

/** The exact configured references, not a guess at tools mentioned in instructions. */
async function missingDependencies(
  options: AssetWorkflowOptions,
  call: Pick<AssetCall, "access" | "runtime">,
  config: unknown,
  wanted: AgentAvailability | undefined
) {
  const parsed = agentConfigSchema.safeParse(config);
  if (!parsed.success) return [];
  const references = [
    ...(parsed.data.knowledgeBases ?? []).map((name) => ({
      kind: "knowledge_base" as const,
      name
    })),
    ...[
      ...new Set(
        parsed.data.toolNames.flatMap((name) => {
          const connection = parseConnectionOperationName(name);
          return connection ? [connection.connection] : [];
        })
      )
    ].map((name) => ({ kind: "connection" as const, name }))
  ];
  const missing: {
    asset: ConfigAssetRecord;
    current: AgentAvailability | undefined;
    summary: MissingDependency;
  }[] = [];
  for (const reference of references) {
    const asset = await options.configAssets.store.getConfigAsset({
      clientInstanceId: options.clientInstanceId,
      ...reference
    });
    if (!asset || asset.status !== "active") continue;
    const availability = await options.configAssets.store.listAgentAvailability({
      clientInstanceId: options.clientInstanceId,
      kind: reference.kind,
      agentName: reference.name
    });
    const current = availability.get(reference.name);
    if (availabilityCovers(current, wanted)) continue;
    const kind = options.configAssets.kinds.get(reference.kind);
    if (!kind) continue;
    const resource = accessResource(asset.kind, asset.name, asset.scope, asset.id);
    const locale = call.runtime?.locale ?? options.config.localization.defaultLocale;
    const readable = call.access.authorize(kind.actions.read, resource).allowed;
    const label = readable
      ? kind.summarize(asset.config, locale).title
      : reference.kind === "connection"
        ? locale === "de"
          ? "Verbindung"
          : "Connection"
        : locale === "de"
          ? "Wissensbasis"
          : "Knowledge Base";
    missing.push({
      asset,
      current,
      summary: {
        ...reference,
        displayName: label ?? asset.name,
        canMakeAvailable:
          call.access.authorize(kind.actions.write).allowed &&
          call.access.authorize(kind.actions.write, resource).allowed
      }
    });
  }
  return missing;
}

/** Only publishers/writers read dependency names; members learn no settings or secret. */
export async function agentDependencyAvailability(
  options: AssetWorkflowOptions,
  call: AssetCall,
  config: unknown,
  wanted: AgentAvailability | undefined
): Promise<NonNullable<Asset["dependencyAvailability"]>> {
  const missing = await missingDependencies(options, call, config, wanted);
  const administrator = missing.length
    ? await options.stores.users.getInstanceAdminName({
        clientInstanceId: options.clientInstanceId
      })
    : undefined;
  return {
    availability: wanted ?? null,
    missing: missing.map(({ summary }) => summary),
    administrators: administrator ? [administrator] : []
  };
}

function authorizeMissingDependencies(
  options: AssetWorkflowOptions,
  access: ActorAccess,
  missing: Awaited<ReturnType<typeof missingDependencies>>
): OperationAuthorization {
  for (const { asset } of missing) {
    const action = options.configAssets.kinds.require(asset.kind).actions.write;
    for (const resource of [
      undefined,
      accessResource(asset.kind, asset.name, asset.scope, asset.id)
    ]) {
      const decision = access.authorize(action, resource);
      if (!decision.allowed) return { allowed: false, action, reason: decision.reason };
    }
  }
  return { allowed: true };
}

/** A consent call must be possible before a policy can file it for another person's approval. */
export async function authorizeAgentDependencies(
  options: AssetWorkflowOptions,
  access: ActorAccess,
  config: unknown,
  wanted: AgentAvailability | undefined
): Promise<OperationAuthorization> {
  return authorizeMissingDependencies(
    options,
    access,
    await missingDependencies(options, { access }, config, wanted)
  );
}

/** Caller supplies a transaction, so refusal or failed publish rolls back every extension. */
export async function makeAgentDependenciesAvailable(
  options: AssetWorkflowOptions,
  call: AssetCall,
  config: unknown,
  wanted: AgentAvailability | undefined
) {
  const missing = await missingDependencies(options, call, config, wanted);
  const decision = authorizeMissingDependencies(options, call.access, missing);
  if (!decision.allowed)
    throw operationDenialError({
      kind: "forbidden",
      action: decision.action,
      reason: decision.reason
    });
  if (!wanted) return;
  for (const { asset, current } of missing) {
    if (asset.kind !== "knowledge_base" && asset.kind !== "connection")
      throw new AppError("INTERNAL", "Invalid dependency kind");
    const availability = await options.configAssets.store.setAgentAvailability({
      clientInstanceId: options.clientInstanceId,
      kind: asset.kind,
      agentName: asset.name,
      expectedAssetId: asset.id,
      expectedAvailability: current ?? null,
      availability: unionAvailability(current, wanted)
    });
    await options.stores.audit.appendAuditEvent({
      clientInstanceId: options.clientInstanceId,
      actor: auditActorFromIdentity(call.actor),
      type: "config_asset.availability_set",
      status: "success",
      correlationId: call.correlationId,
      metadata: {
        ...(call.runId ? { operationRunId: call.runId } : {}),
        kind: asset.kind,
        name: asset.name,
        mode: availability.mode,
        personalWorkspaces: availability.personalWorkspaces,
        collaborationWorkspaceIds: availability.collaborationWorkspaceIds
      }
    });
  }
}
