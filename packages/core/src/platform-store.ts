import type { AgentRunStore, RunObservationStore } from "./agent-runtime";
import type { AuditEventStore } from "./audit";
import type { ConversationRetentionStore, ConversationStore } from "./conversation";
import type { CollaborationWorkspaceStore } from "./collaboration-workspace";
import type { ConfigAssetStore } from "./config-assets";
import type {
  ExecutionWorkspaceCleanupStore,
  ExecutionWorkspaceFileStore,
  ExecutionWorkspaceMetadataStore,
  WorkspaceCommandStore
} from "./execution-workspace";
import type { PlatformFileStore } from "./files";
import type { ModelUsageEventStore } from "./usage";
import type { UserStore } from "./user";
import type { ApiAccessStore } from "./api-access";
import type { StructuredDataStore } from "./structured-data";

export interface PlatformStore
  extends
    ConversationStore,
    ConversationRetentionStore,
    CollaborationWorkspaceStore,
    PlatformFileStore,
    AgentRunStore,
    RunObservationStore,
    ExecutionWorkspaceMetadataStore,
    ExecutionWorkspaceFileStore,
    WorkspaceCommandStore,
    ExecutionWorkspaceCleanupStore,
    AuditEventStore,
    ModelUsageEventStore,
    UserStore,
    ApiAccessStore,
    ConfigAssetStore,
    StructuredDataStore {
  close?: () => Promise<void>;
}
