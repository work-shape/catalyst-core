import {
  isAgentAvailableInWorkspace,
  type CollaborationWorkspace,
  type RuntimeAssetSnapshot
} from "@vivd-catalyst/core";
import type { ChatServerOptions } from "./types";

/**
 * The runtime assets as one workspace sees them. Every path that lists agents for a user or
 * starts a run goes through here, so availability is enforced in one place.
 *
 * Default agent: the workspace's own default (not built yet), then the instance default if it
 * is available here, then the first available agent.
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
  return {
    ...assets,
    agents,
    defaultAgentName: agents.some((agent) => agent.name === assets.defaultAgentName)
      ? assets.defaultAgentName
      : agents[0]?.name
  };
}
