import type { ActionScopes } from "./action-scopes";

export const SKILL_GRANT_SCOPES = {
  "skill.read": ["workspace", "asset"],
  "skill.write": ["workspace", "asset"],
  // Makes the shared draft of a team's or the instance's skill live (SKILL-DRAFT-1).
  "skill.publish": ["workspace", "asset"],
  "skill.delete": ["workspace", "asset"]
} as const satisfies ActionScopes;
