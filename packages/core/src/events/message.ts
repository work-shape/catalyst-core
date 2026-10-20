import { LEGACY_AUDIT, type PlatformEventDefinition } from "./definition";

export const messageEvents = {
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
