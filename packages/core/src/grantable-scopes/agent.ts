import type { ActionScopes } from "./action-scopes";

export const AGENT_GRANT_SCOPES = {
  "agent.read": ["workspace", "asset"],
  "agent.write": ["workspace", "asset"],
  "agent.publish": ["workspace", "asset"],
  // Decides a held publish of an agent a workspace owns (WS-PUB-1b): on that agent, on what one
  // workspace owns, or on every agent. Self-approval with one's own Publish needs it on the
  // instance; a holder in a workspace decides that workspace's requests in the Inbox.
  "agent.approve": ["workspace", "asset", "instance"],
  "agent.delete": ["workspace", "asset"],
  // Converse with it where it is available. An agent set to Everyone needs no row; one
  // limited to the right is used by whom a row allows (AGENT-USE-1).
  "agent.use": ["workspace", "asset", "instance"]
} as const satisfies ActionScopes;
