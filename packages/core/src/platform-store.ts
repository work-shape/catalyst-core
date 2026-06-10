import type { AuditEventStore } from "./audit";
import type { ConversationStore } from "./conversation";
import type { ModelUsageEventStore } from "./usage";
import type { UserStore } from "./user";

export interface PlatformStore
  extends ConversationStore,
    AuditEventStore,
    ModelUsageEventStore,
    UserStore {
  close?: () => Promise<void>;
}
