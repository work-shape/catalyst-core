import type { AgentRunStore, RunObservationStore } from "./agent-runtime";
import type { AuditEventStore } from "./audit";
import type {
  ConversationRetentionStore,
  ConversationStore,
  ModelProviderContinuationStore
} from "./conversation";
import type { CollaborationWorkspaceStore } from "./collaboration-workspace";
import type { ApprovalDecisionStore, ApprovalRequestStore } from "./approval-requests";
import type { ConfigAssetStore } from "./config-assets";
import type {
  ExecutionWorkspaceCleanupStore,
  ExecutionWorkspaceFileStore,
  ExecutionWorkspaceMetadataStore,
  WorkspaceCommandStore
} from "./execution-workspace";
import type { PlatformFileStore } from "./files";
import type { JobsStore } from "./jobs";
import type { OperationRunStore } from "./operation-runs";
import type { ModelUsageEventStore } from "./usage";
import type { UserStore } from "./user";
import type { ApiAccessStore } from "./api-access";
import type { StructuredDataStore } from "./structured-data";

export interface ConversationsStore
  extends ConversationStore, ConversationRetentionStore, ModelProviderContinuationStore {}

export interface AgentRunsStore extends AgentRunStore, RunObservationStore {}

export interface ApprovalsStore extends ApprovalRequestStore, ApprovalDecisionStore {}

export interface ExecutionWorkspacesStore
  extends
    ExecutionWorkspaceMetadataStore,
    ExecutionWorkspaceFileStore,
    WorkspaceCommandStore,
    ExecutionWorkspaceCleanupStore {}

/** Domain stores bound to the same persistence connection or transaction. */
export interface PlatformStores {
  conversations: ConversationsStore;
  agentRuns: AgentRunsStore;
  files: PlatformFileStore;
  audit: AuditEventStore;
  usage: ModelUsageEventStore;
  users: UserStore;
  workspaces: CollaborationWorkspaceStore;
  apiAccess: ApiAccessStore;
  configAssets: ConfigAssetStore;
  approvals: ApprovalsStore;
  executionWorkspaces: ExecutionWorkspacesStore;
  structuredData: StructuredDataStore;
  jobs: JobsStore;
  operationRuns: OperationRunStore;
  /** Resolves after commit; a rejected callback rolls back all domain writes. Nested calls use savepoints. */
  transaction<T>(fn: (stores: PlatformStores) => Promise<T>): Promise<T>;
  close?: () => Promise<void>;
}
