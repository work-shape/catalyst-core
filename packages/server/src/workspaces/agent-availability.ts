import { apiOperations } from "@work-shape/catalyst-api-contract";
import {
  hasAuthScope,
  INSTANCE_ASSET_SCOPE,
  isAgentAvailableInWorkspace,
  type ActorAccess,
  type AuthenticatedUser,
  type CollaborationWorkspace,
  type RuntimeAssetSnapshot
} from "@work-shape/catalyst-core";
import { accessResource } from "../assets/asset-access";
import type { ChatServerOptions } from "../types";

/** The agent kind and the right that writes one, as the kind registers them. */
const AGENT_KIND = "agent";
const AGENT_WRITE = "agent.write";

/**
 * The runtime assets as one workspace sees them. Every path that lists agents for a user or
 * starts a run goes through here, so availability is enforced in one place.
 *
 * Default agent: the workspace's own default (not built yet), then the instance default if it
 * is available here, then, where the instance names none, the agent the platform ships if it is
 * available here, then the first available agent.
 */
export async function getWorkspaceAssetSnapshot(
  options: Pick<ChatServerOptions, "configAssets" | "clientInstanceId">,
  workspace: { kind: CollaborationWorkspace["kind"]; id?: CollaborationWorkspace["id"] }
): Promise<RuntimeAssetSnapshot> {
  const [assets, availability] = await Promise.all([
    options.configAssets.source.getSnapshot(),
    options.configAssets.store.listAgentAvailability({
      clientInstanceId: options.clientInstanceId
    })
  ]);
  const agents = assets.agents.filter((agent) =>
    isAgentAvailableInWorkspace(availability.get(agent.name), workspace)
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
