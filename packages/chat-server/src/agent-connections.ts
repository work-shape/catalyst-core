import type { SafeConfigConnection } from "@work-shape/catalyst-config-schema";
import type { ChatServerOptions } from "./types";

/**
 * The Connections of the instance with the tools an agent can carry, for the agents a person
 * is offered. They are read without asking what the person may read of Connections: an agent
 * list names a Connection only for an agent that holds a tool of it, and then its name for
 * people, its icon and the tools that agent holds, which the person meets in every
 * conversation with the agent. Nothing where the module `connections` is off.
 */
export async function agentConnections(
  options: Pick<ChatServerOptions, "connections">
): Promise<SafeConfigConnection[]> {
  if (!options.connections) {
    return [];
  }
  const { connections } = await options.connections.listTools(() => true);
  return connections.map(({ name, title, service, connectorType, tools }) => ({
    name,
    title,
    ...(service === undefined ? {} : { service }),
    ...(connectorType === undefined ? {} : { connectorType }),
    tools: tools.map(({ toolName, effect }) => ({ toolName, effect }))
  }));
}
