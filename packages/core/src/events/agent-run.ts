import { LEGACY_AUDIT, type PlatformEventDefinition } from "./definition";

export const agentRunEvents = {
  "agent_run.recovered": { ...LEGACY_AUDIT, name: "agent_run.recovered", subject: "agent_run" }
} as const satisfies Record<string, PlatformEventDefinition>;
