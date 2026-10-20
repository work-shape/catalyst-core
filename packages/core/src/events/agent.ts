import type { PlatformEventDefinition } from "./definition";

export const agentEvents = {
  // Guardrails answer here before a Workflow's revision goes live. The subject is the Workflow.
  "agent.before_publish": {
    name: "agent.before_publish",
    subject: "config_asset",
    legacy: false,
    audited: false,
    phases: ["before"]
  }
} as const satisfies Record<string, PlatformEventDefinition>;
