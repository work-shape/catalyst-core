import type { ActionScopes } from "./action-scopes";

export const TOOL_GRANT_SCOPES = {
  // A tool asset is owned by the instance or by one workspace (TOOL-1): its rights are granted
  // on one tool, on those a workspace owns, or on all of them. Calling a published tool needs
  // no right of its own: it writes only into the caller's own conversation.
  "tool.read": ["workspace", "asset", "instance"],
  "tool.write": ["workspace", "asset", "instance"],
  "tool.publish": ["workspace", "asset", "instance"],
  // Decides a held publish of a tool, as `agent.approve` does for an agent.
  "tool.approve": ["workspace", "asset", "instance"],
  "tool.delete": ["workspace", "asset", "instance"]
} as const satisfies ActionScopes;
