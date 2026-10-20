import type { ActionScopes } from "./action-scopes";

export const SKILL_GRANT_SCOPES = {
  "skill.read": ["workspace", "asset"],
  "skill.write": ["workspace", "asset"],
  "skill.delete": ["workspace", "asset"]
} as const satisfies ActionScopes;
