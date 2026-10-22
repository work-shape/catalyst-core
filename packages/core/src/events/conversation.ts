import { INSTANCE_TARGET_KINDS } from "../conversation";
import { LEGACY_AUDIT, type PlatformEventDefinition } from "./definition";

export const conversationEvents = {
  "conversation.cleanup_completed": {
    ...LEGACY_AUDIT,
    name: "conversation.cleanup_completed",
    subject: "conversation"
  },
  "conversation.cleanup_failed": {
    ...LEGACY_AUDIT,
    name: "conversation.cleanup_failed",
    subject: "conversation"
  },
  "conversation.created": {
    ...LEGACY_AUDIT,
    name: "conversation.created",
    subject: "conversation"
  },
  "conversation.deleted": {
    ...LEGACY_AUDIT,
    name: "conversation.deleted",
    subject: "conversation"
  },
  // A first save in a conversation started under Studio's scope "Instance" was refused: the
  // person may not create the kind for the instance (studio-chat-entry.md, section 4a). The
  // subject is the conversation. The metadata names the kind only: no name, no config.
  "conversation.instance_create_refused": {
    name: "conversation.instance_create_refused",
    subject: "conversation",
    legacy: false,
    audited: true,
    phases: ["after"],
    payload: {
      type: "object",
      additionalProperties: false,
      required: ["kind"],
      properties: {
        kind: { type: "string", enum: [...INSTANCE_TARGET_KINDS] },
        operationRunId: { type: "string" }
      }
    }
  },
  "conversation.moved": { ...LEGACY_AUDIT, name: "conversation.moved", subject: "conversation" },
  "conversation.renamed": {
    ...LEGACY_AUDIT,
    name: "conversation.renamed",
    subject: "conversation"
  },
  "conversation.retention_expiration_failed": {
    ...LEGACY_AUDIT,
    name: "conversation.retention_expiration_failed",
    subject: "conversation"
  },
  "conversation.retention_expired": {
    ...LEGACY_AUDIT,
    name: "conversation.retention_expired",
    subject: "conversation"
  },
  "conversation.subject_opened": {
    ...LEGACY_AUDIT,
    name: "conversation.subject_opened",
    subject: "conversation"
  },
  "conversation.title_generated": {
    ...LEGACY_AUDIT,
    name: "conversation.title_generated",
    subject: "conversation"
  },
  "conversation.title_generation_failed": {
    ...LEGACY_AUDIT,
    name: "conversation.title_generation_failed",
    subject: "conversation"
  }
} as const satisfies Record<string, PlatformEventDefinition>;
