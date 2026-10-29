import type { ActorAccess } from "@work-shape/catalyst-core";
import type { ChatServerOptions } from "../types";
import { accessResource } from "./asset-access";

const AGENT_ASSET_KIND = "agent";

/** One agent the caller may read, with the tools and skills its definition lists. */
export interface ReadableAgent {
  name: string;
  title: string;
  toolNames: readonly string[];
  skillNames: readonly string[];
}

/**
 * The agents of the instance the caller may read, each with the names its definition lists: what
 * a "used by" may name. An agent the caller may not read is left out, its name included.
 */
export async function readableAgents(
  options: Pick<ChatServerOptions, "clientInstanceId" | "configAssets">,
  access: ActorAccess
): Promise<ReadableAgent[]> {
  const kind = options.configAssets.kinds.get(AGENT_ASSET_KIND);
  if (!kind) return [];
  const agents = await options.configAssets.store.listActiveConfigAssets({
    clientInstanceId: options.clientInstanceId,
    kind: AGENT_ASSET_KIND
  });
  return agents.flatMap((agent) => {
    const resource = accessResource(agent.kind, agent.name, agent.scope, agent.id);
    if (!access.authorize(kind.actions.read, resource).allowed) return [];
    let title = agent.name;
    try {
      title = kind.summarize(agent.config).title;
    } catch {
      // A stored agent this build does not read keeps its name as its title.
    }
    return [
      {
        name: agent.name,
        title,
        toolNames: namesOf(agent.config?.toolNames),
        skillNames: namesOf(agent.config?.skillNames)
      }
    ];
  });
}

function namesOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((name): name is string => typeof name === "string")
    : [];
}
