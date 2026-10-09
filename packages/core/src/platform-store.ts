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

/**
 * Whether the database can serve this release: it answers, and it holds every migration the
 * release was built with. A database ahead of the release is ready. `migration` is the newest
 * migration of the release, which a ready database has applied. The value names migrations
 * only: no host, no account and nothing the driver reported.
 */
export type DatabaseReadiness =
  | { status: "ready"; migration: string }
  | { status: "not_ready"; reason: "database_unreachable" }
  | { status: "not_ready"; reason: "database_behind"; missing: string[] };

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
  /** Absent, like `close`, on stores bound to a transaction. It never rejects. */
  readiness?: () => Promise<DatabaseReadiness>;
}

/** The readiness of the database behind `stores`. Stores that cannot say are not ready. */
export async function readDatabaseReadiness(stores: PlatformStores): Promise<DatabaseReadiness> {
  return (await stores.readiness?.()) ?? { status: "not_ready", reason: "database_unreachable" };
}
