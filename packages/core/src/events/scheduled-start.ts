import type { PlatformEventDefinition } from "./definition";

export const scheduledStartEvents = {
  "scheduled_start.fired": {
    name: "scheduled_start.fired",
    subject: "scheduled_start",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["conversationId", "agentRunId"],
      properties: {
        conversationId: { type: "string" },
        agentRunId: { type: "string" }
      }
    }
  }
} as const satisfies Record<string, PlatformEventDefinition>;
