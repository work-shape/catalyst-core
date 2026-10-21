import type { ActionScopes } from "./action-scopes";

export const AGENT_GRANT_SCOPES = {
  "agent.read": ["workspace", "asset"],
  "agent.write": ["workspace", "asset"],
  "agent.publish": ["workspace", "asset"],
  "agent.delete": ["workspace", "asset"],
  // Converse with it where it is available. An agent set to Everyone needs no row; one
  // limited to the right is used by whom a row allows (AGENT-USE-1).
  "agent.use": ["workspace", "asset", "instance"]
} as const satisfies ActionScopes;
