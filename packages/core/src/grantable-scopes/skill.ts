import type { ActionScopes } from "./action-scopes";

export const SKILL_GRANT_SCOPES = {
  "skill.read": ["workspace", "asset"],
  "skill.write": ["workspace", "asset"],
  // A save of a team's or the instance's skill is live with it; without it, a request (SKILL-LIVE-1).
  "skill.publish": ["workspace", "asset"],
  "skill.delete": ["workspace", "asset"],
  // Decides a proposed change of a skill: on that skill, or on what one workspace owns. On the
  // instance it stays the legacy key's (`agent_skills.approve`).
  "skill.approve": ["workspace", "asset"]
} as const satisfies ActionScopes;
