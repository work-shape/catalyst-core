import type { AuditEventStore } from "./audit";
import type { ConversationRetentionStore, ConversationStore } from "./conversation";
import type { PlatformFileStore } from "./files";
import type { ModelUsageEventStore } from "./usage";
import type { UserStore } from "./user";

export interface PlatformStore
  extends ConversationStore,
    ConversationRetentionStore,
    PlatformFileStore,
    AuditEventStore,
    ModelUsageEventStore,
    UserStore {
  close?: () => Promise<void>;
}
