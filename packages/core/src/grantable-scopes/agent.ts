import type { ActionScopes } from "./action-scopes";

export const AGENT_GRANT_SCOPES = {
  "agent.read": ["workspace", "asset"],
  "agent.write": ["workspace", "asset"],
  "agent.publish": ["workspace", "asset"],
  "agent.delete": ["workspace", "asset"]
} as const satisfies ActionScopes;
