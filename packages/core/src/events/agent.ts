import type { PlatformEventDefinition } from "./definition";

export const agentEvents = {
  // Guardrails answer here before a Workflow's revision goes live. The subject is the Workflow.
  "agent.before_publish": {
    name: "agent.before_publish",
    subject: "config_asset",
    legacy: false,
    audited: false,
    phases: ["before"]
  },
  // Guardrails answer here before the shared draft of a team's or the instance's skill goes
  // live (SKILL-DRAFT-1). The subject is the skill. No guardrail is bound to it by default.
  "skill.before_publish": {
    name: "skill.before_publish",
    subject: "config_asset",
    legacy: false,
    audited: false,
    phases: ["before"]
  },
  // A start or a message refused for want of `agent.use` (AGENT-USE-1): who, which agent, where
  // and through which entry, never what the message said.
  "agent.use_refused": {
    name: "agent.use_refused",
    subject: "config_asset",
    legacy: false,
    audited: true,
    phases: ["after"]
  }
} as const satisfies Record<string, PlatformEventDefinition>;
