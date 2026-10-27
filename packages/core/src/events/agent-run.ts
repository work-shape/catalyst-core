import { LEGACY_AUDIT, type PlatformEventDefinition } from "./definition";

export const agentRunEvents = {
  "agent_run.recovered": { ...LEGACY_AUDIT, name: "agent_run.recovered", subject: "agent_run" },
  // A person reported a run that failed for a platform reason to the operator's support
  // address (PLATFORM-REPORT). The run, the code and the report only: never the person's note,
  // the address or anything of the conversation.
  "agent_run.platform_reported": {
    name: "agent_run.platform_reported",
    subject: "agent_run",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["reportId", "errorCode"],
      properties: {
        reportId: { type: "string" },
        errorCode: { type: "string" }
      }
    }
  }
} as const satisfies Record<string, PlatformEventDefinition>;
