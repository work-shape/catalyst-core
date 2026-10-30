import { LEGACY_AUDIT, type PlatformEventDefinition } from "./definition";

export const messageEvents = {
  // The person's chat message before it is stored or a model reads it (GR-4). Guardrails answer
  // here with patterns only, and nothing of the message is kept.
  "message.before_send": {
    name: "message.before_send",
    subject: "message",
    legacy: false,
    audited: false,
    phases: ["before"]
  },
  "message.cancelled": { ...LEGACY_AUDIT, name: "message.cancelled", subject: "message" },
  "message.completed": { ...LEGACY_AUDIT, name: "message.completed", subject: "message" },
  "message.created": {
    ...LEGACY_AUDIT,
    name: "message.created",
    subject: "message",
    payload: {
      type: "object",
      properties: {
        conversationId: { type: "string" },
        attachmentCount: { type: "integer" },
        delivery: { const: "queued" }
      }
    }
  },
  "message.failed": { ...LEGACY_AUDIT, name: "message.failed", subject: "message" }
} as const satisfies Record<string, PlatformEventDefinition>;
