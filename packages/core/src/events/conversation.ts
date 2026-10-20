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
