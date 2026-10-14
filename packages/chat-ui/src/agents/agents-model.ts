import type { CollaborationWorkspaceAgents, SafeConfig } from "@vivd-catalyst/api-client";
import type { BuildAssetStart } from "../build-area/build-asset-kind";
import { requestBuildStart } from "../build-area/build-create-request";
import type { BuildNamespace } from "../build-area/build-rights";
import { AGENTS_BUILD_PATH, buildRouteOfLocation } from "../build-area/build-route";
import type { WorkspaceRoute } from "../routes";

/** One agent as the instance answers it for the agent picker. */
export type OfferedAgent = SafeConfig["agents"][number];

/** What the dialog that starts an agent on the Agents page offers the viewer. */
export interface AgentCreation {
  /** The Namespaces the viewer may name a new agent in. */
  namespaces: readonly BuildNamespace[];
  /** The viewer may name an agent outside every Namespace. */
  mayNameFreely: boolean;
}

/** How the list of the open workspace's agents stands. */
export type AgentListStatus = "loading" | "failed" | "ready";

/**
 * The state of the workspace's own list. The page waits for it: until it arrives the
 * configuration still holds the agents of the whole instance, which are not all offered here.
 */
export function agentListStatus(list: { loaded: boolean; failed: boolean }): AgentListStatus {
  return list.loaded ? "ready" : list.failed ? "failed" : "loading";
}

/**
 * Whether the Agents row of the sidebar shows: the session has workspaces and the instance says
 * the row is there for the person in the open workspace, which it does with two agents or more
 * there or the right to write one. With one agent New chat starts it and the composer's picker
 * stays. Unknown counts as none until the workspace's list arrived. The page keeps its address.
 */
export function agentsRowShown(
  workspaces: boolean,
  list: Pick<CollaborationWorkspaceAgents, "visibleSections"> | undefined
): boolean {
  return workspaces && list?.visibleSections.includes("agents") === true;
}

/** The page of an agent in Studio. */
export function agentStudioRoute(agentName: string): WorkspaceRoute {
  return buildRouteOfLocation({ kindPath: AGENTS_BUILD_PATH, name: agentName });
}

/**
 * Opens the page of the new agent the dialog on the Agents page started. It is written there,
 * where every agent is.
 */
export function startNewAgent(
  showRoute: (route: WorkspaceRoute) => void,
  start: BuildAssetStart
): void {
  requestBuildStart(AGENTS_BUILD_PATH, start);
  showRoute(agentsStudioRoute());
}

/** The list of the agents in Studio. */
export function agentsStudioRoute(): WorkspaceRoute {
  return buildRouteOfLocation({ kindPath: AGENTS_BUILD_PATH });
}
