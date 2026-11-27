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
 * The agents a list of the caller's own connections names may also be ones they only use.
 */
export async function readableAgents(
  options: Pick<ChatServerOptions, "clientInstanceId" | "configAssets">,
  access: ActorAccess,
  /** Also the agents the caller may only use: a person knows by name whom they chat with. */
  orUsable = false
): Promise<ReadableAgent[]> {
  const kind = options.configAssets.kinds.get(AGENT_ASSET_KIND);
  if (!kind) return [];
  const agents = await options.configAssets.store.listActiveConfigAssets({
    clientInstanceId: options.clientInstanceId,
    kind: AGENT_ASSET_KIND
  });
  return agents.flatMap((agent) => {
    const resource = accessResource(agent.kind, agent.name, agent.scope, agent.id);
    const rights = orUsable ? [kind.actions.read, kind.actions.use] : [kind.actions.read];
    if (!rights.some((right) => right !== undefined && access.authorize(right, resource).allowed))
      return [];
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
