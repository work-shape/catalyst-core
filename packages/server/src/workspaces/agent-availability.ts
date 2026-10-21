import { apiOperations } from "@work-shape/catalyst-api-contract";
import {
  hasAuthScope,
  INSTANCE_ASSET_SCOPE,
  agentUseRefusalOf,
  auditActorFromIdentity,
  createAuthorizer,
  isAgentAvailableInWorkspace,
  operationDenialError,
  type ActorAccess,
  type AuthenticatedIdentity,
  type AuthenticatedUser,
  type CollaborationWorkspace,
  type RuntimeAssetSnapshot
} from "@work-shape/catalyst-core";
import { accessResource } from "../assets/asset-access";
import type { ChatServerOptions } from "../types";

/** The agent kind and the rights that write one and use one, as the kind registers them. */
const AGENT_KIND = "agent";
const AGENT_WRITE = "agent.write";
export const AGENT_USE = "agent.use";

type WorkspaceRef = { kind: CollaborationWorkspace["kind"]; id?: CollaborationWorkspace["id"] };
type SnapshotOptions = Pick<ChatServerOptions, "configAssets" | "clientInstanceId">;
type UseCheckOptions = SnapshotOptions & Pick<ChatServerOptions, "stores">;

/** Where a person reached for an agent, as `agent.use_refused` names it: a message in a
 * conversation (from the chat or the API alike), a queued follow-up, a scheduled prompt, a subagent. */
export type AgentUseEntry = "conversation" | "follow_up" | "schedule" | "subagent";

/** One start of an agent by a caller, as `requireAgentUse` decides and records it. */
export interface AgentUseCheck {
  actor: AuthenticatedIdentity;
  access: ActorAccess;
  workspace: WorkspaceRef;
  agentName: string;
  entry: AgentUseEntry;
  correlationId: string;
}

/** Why `agent.use` refuses an agent that is available: no row allows it, or one denies it. */
export type AgentUseRefusal = "no_grant" | "denied";

/**
 * The agents offered in one workspace, before the caller's rights: the instance's snapshot,
 * the agents available there, and which of them only holders of `agent.use` may use.
 */
async function offeredAgents(options: SnapshotOptions, workspace: WorkspaceRef) {
  const [assets, availability, limited] = await Promise.all([
    options.configAssets.source.getSnapshot(),
    options.configAssets.store.listAgentAvailability({
      clientInstanceId: options.clientInstanceId
    }),
    options.configAssets.store.listAgentUseLimits({ clientInstanceId: options.clientInstanceId })
  ]);
  const available = assets.agents.filter((agent) =>
    isAgentAvailableInWorkspace(availability.get(agent.name), workspace)
  );
  return { assets, available, limited };
}

/**
 * Whether the caller may use an agent that is available where they are (AGENT-USE-1). An agent
 * set to Everyone is used by everyone who may work there, unless a covering deny of `agent.use`
 * refuses; a limited one only where a row allows `agent.use` on it.
 */
export function agentUseRefusal(
  access: ActorAccess,
  assets: Pick<RuntimeAssetSnapshot, "agentKeys">,
  limited: ReadonlySet<string>,
  agentName: string
): AgentUseRefusal | undefined {
  const key = assets.agentKeys?.get(agentName);
  return agentUseRefusalOf(
    access.authorize(
      AGENT_USE,
      accessResource(AGENT_KIND, agentName, key?.scope ?? INSTANCE_ASSET_SCOPE, key?.id)
    ),
    limited.has(agentName)
  );
}

/**
 * The runtime assets as one workspace sees them, for the caller. Every path that lists agents
 * for a person or starts a run goes through here, so availability and `agent.use` are enforced
 * in one place: an agent is listed where it is available and the caller may use it.
 *
 * Default agent: the workspace's own default (not built yet), then the instance default if it
 * is offered to the caller here, then, where the instance names none, the agent the platform
 * ships if it is offered here, then the first offered agent.
 */
export async function getWorkspaceAssetSnapshot(
  options: SnapshotOptions,
  workspace: WorkspaceRef,
  access: ActorAccess
): Promise<RuntimeAssetSnapshot> {
  const { assets, available, limited } = await offeredAgents(options, workspace);
  const agents = available.filter(
    (agent) => agentUseRefusal(access, assets, limited, agent.name) === undefined
  );
  const offered = (name: string | undefined) => agents.some((agent) => agent.name === name);
  return {
    ...assets,
    agents,
    defaultAgentName: offered(assets.defaultAgentName)
      ? assets.defaultAgentName
      : // Where the instance names no default, the agent the platform ships is it wherever it
        // is offered (Felix, 2026-10-21); an instance's own default is never replaced.
        ((assets.defaultAgentName === undefined
          ? agents.find((agent) => agent.shipped !== undefined)?.name
          : undefined) ?? agents[0]?.name)
  };
}

/**
 * Refuses a start of an agent that is available in the workspace and that the caller may not
 * use, with `FORBIDDEN` naming `agent.use`, and records the refusal: who, which agent, where and
 * through which entry, never what was asked. An agent that is not available, or unknown, is
 * left to the caller, which answers as it always did.
 */
export async function requireAgentUse(
  options: UseCheckOptions,
  input: AgentUseCheck
): Promise<void> {
  const refusal = await agentUseRefusalIn(options, input);
  if (refusal === undefined) return;
  throw operationDenialError({ kind: "forbidden", action: AGENT_USE, reason: refusal });
}

/**
 * The refusal `requireAgentUse` throws, recorded and returned, for a caller that answers
 * otherwise, such as a scheduled start that is skipped.
 */
export async function agentUseRefusalIn(
  options: UseCheckOptions,
  input: AgentUseCheck
): Promise<AgentUseRefusal | undefined> {
  const { assets, available, limited } = await offeredAgents(options, input.workspace);
  if (!available.some((agent) => agent.name === input.agentName)) return undefined;
  const refusal = agentUseRefusal(input.access, assets, limited, input.agentName);
  if (refusal !== undefined)
    await recordAgentUseRefusal(
      options,
      input,
      refusal,
      assets.agentKeys?.get(input.agentName)?.id
    );
  return refusal;
}

/** `agent.use_refused`: who, which agent, where and through which entry, never what was asked. */
export async function recordAgentUseRefusal(
  options: Pick<ChatServerOptions, "clientInstanceId" | "stores">,
  input: Omit<AgentUseCheck, "access">,
  refusal: AgentUseRefusal,
  agentId: string | undefined
): Promise<void> {
  await options.stores.audit.appendAuditEvent({
    clientInstanceId: options.clientInstanceId,
    type: "agent.use_refused",
    status: "denied",
    actor: auditActorFromIdentity(input.actor),
    ...(agentId === undefined ? {} : { subject: agentId }),
    reason: refusal,
    correlationId: input.correlationId,
    metadata: {
      agentName: input.agentName,
      ...(agentId === undefined ? {} : { agentId }),
      ...(input.workspace.id === undefined ? {} : { workspaceId: input.workspace.id }),
      workspaceKind: input.workspace.kind,
      entry: input.entry
    }
  });
}

/**
 * What the caller may do: the access the request decided with, or the caller's own, loaded
 * here for a path that runs without one, such as a follow-up or a scheduled start.
 */
export async function callerAccess(
  options: {
    authorizer?: ChatServerOptions["authorizer"];
    stores: Pick<ChatServerOptions["stores"], "access">;
  },
  actor: AuthenticatedIdentity,
  access?: ActorAccess
): Promise<ActorAccess> {
  return access ?? (options.authorizer ?? createAuthorizer(options.stores.access)).forActor(actor);
}

/**
 * Whether the caller may write an agent of the snapshot, decided as a write of it is: on its
 * id and its owner, with a credential that may write assets at all. What the chat offers to
 * choose of an agent's models depends on it.
 */
export function agentWriter(
  caller: { user: AuthenticatedUser; access: ActorAccess },
  assets: Pick<RuntimeAssetSnapshot, "agentKeys">
): (agentName: string) => boolean {
  const writes = hasAuthScope(caller.user, apiOperations["assets.put"].scope);
  return (agentName) => {
    const key = assets.agentKeys?.get(agentName);
    return (
      writes &&
      caller.access.authorize(
        AGENT_WRITE,
        accessResource(AGENT_KIND, agentName, key?.scope ?? INSTANCE_ASSET_SCOPE, key?.id)
      ).allowed
    );
  };
}
