import type { SafeConfig } from "@vivd-catalyst/api-client";
import { requestBuildCreate } from "../build-area/build-create-request";
import { AGENTS_BUILD_PATH, buildRouteOfLocation } from "../build-area/build-route";
import type { WorkspaceRoute } from "../routes";

/** One agent as the instance answers it for the agent picker. */
export type OfferedAgent = SafeConfig["agents"][number];

/** How many of an agent's starter prompts its card offers. */
export const AGENT_CARD_PROMPTS_MAX = 3;

/** How the list of the open workspace's agents stands. */
export type AgentListStatus = "loading" | "failed" | "ready";

/**
 * The state of the workspace's own list. The page waits for it: until it arrives the
 * configuration still holds the agents of the whole instance, which are not all offered here.
 */
export function agentListStatus(list: { loaded: boolean; failed: boolean }): AgentListStatus {
  return list.loaded ? "ready" : list.failed ? "failed" : "loading";
}

/** The starter prompts a card offers: the agent's first ones that have a title and a text. */
export function agentCardPrompts(agent: Pick<OfferedAgent, "initialPrompts">) {
  return agent.initialPrompts
    .filter((prompt) => prompt.title.trim() !== "" && prompt.prompt.trim() !== "")
    .slice(0, AGENT_CARD_PROMPTS_MAX);
}

/** The page of an agent in Studio. */
export function agentStudioRoute(agentName: string): WorkspaceRoute {
  return buildRouteOfLocation({ kindPath: AGENTS_BUILD_PATH, name: agentName });
}

/**
 * Leads to the list of the agents in Studio with the dialog that starts a new one open. The
 * agent is named and written there, where every agent is.
 */
export function startNewAgent(showRoute: (route: WorkspaceRoute) => void): void {
  requestBuildCreate(AGENTS_BUILD_PATH);
  showRoute(agentsStudioRoute());
}

/** The list of the agents in Studio. */
export function agentsStudioRoute(): WorkspaceRoute {
  return buildRouteOfLocation({ kindPath: AGENTS_BUILD_PATH });
}
