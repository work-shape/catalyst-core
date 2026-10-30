import { createPostgresFeedbackStore } from "./postgres-feedback-operations";
import { createPostgresPlatformReportStore } from "./postgres-platform-report-operations";
import { createPostgresProjectStore } from "./postgres-project-operations";
import { createPostgresProjectFileStore } from "./postgres-project-file-operations";
import { createPostgresWorkflowNoticesStore } from "./postgres-workflow-notices";
import { createPostgresNoticeMailStore } from "./postgres-notice-mail";
import {
  listAgentAvailability as listPostgresAgentAvailability,
  agentAwaitsFirstPublish as postgresAgentAwaitsFirstPublish,
  setAgentAvailability as setPostgresAgentAvailability
} from "./postgres-agent-availability";
import {
  listAgentUseLimits as listPostgresAgentUseLimits,
  setAgentUse as setPostgresAgentUse
} from "./postgres-agent-use";
import {
  listPersonalChatSkills as listPostgresPersonalChatSkills,
  setPersonalChatSkill as setPostgresPersonalChatSkill
} from "./postgres-personal-chat-skills";
import { listConfigAssetPage as listPostgresConfigAssetPage } from "./postgres-config-asset-page";
import {
  getConfigAssetPageOrigin as getPostgresConfigAssetPageOrigin,
  listConfigAssetsFromPage as listPostgresConfigAssetsFromPage
} from "./postgres-config-asset-origins";
import {
  deleteWorkspace as deletePostgresWorkspace,
  getWorkspaceInDeletion as getPostgresWorkspaceInDeletion,
  lockWorkspacesForOwnerChange as lockPostgresWorkspacesForOwnerChange,
  markWorkspaceDeletionRequested as markPostgresWorkspaceDeletionRequested
} from "./postgres-workspace-deletion";
import {
  deleteModelProviderContinuation as deletePostgresModelProviderContinuation,
  getModelProviderContinuation as getPostgresModelProviderContinuation,
  getModelProviderTurnContinuation as getPostgresModelProviderTurnContinuation
} from "./postgres-model-provider-continuation-operations";
import { searchWorkspaceFiles as searchPostgresWorkspaceFiles } from "./postgres-file-search-operations";
import {
  listConversationsForWorkspace as listPostgresConversationsForWorkspace,
  listConversationsWithActiveRun as listPostgresConversationsWithActiveRun
} from "./postgres-conversation-list-operations";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  inspectCapabilityRecordsAccess,
  type CapabilityRecordsAccess
} from "./capability-records-access";
import postgres, { type Notice } from "postgres";
import type {
  CapabilityRecordStore,
  DatabaseReadiness,
  Logger,
  PlatformStores
} from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { assertDatabaseMigrated } from "./migrations";
import { createDatabaseReadinessCheck } from "./readiness";
import { schema } from "./schema";
import { createPostgresFollowUpStore } from "./postgres-follow-up-operations";
import { createPostgresScheduledStartsStore } from "./postgres-scheduled-starts";
import { lockActiveConversation } from "./postgres-conversation-operations";
import { createPostgresConversationsStore } from "./postgres-conversation-operations";
import { expireConversation, listExpiredConversations } from "./postgres-conversation-expiry";
import { createPostgresAgentRunsStore } from "./postgres-agent-run-operations";
import { createPostgresChildAgentRunStore } from "./postgres-child-agent-run-operations";
import { createPostgresFilesStore } from "./postgres-file-store";
import { createPostgresAuditStore } from "./postgres-audit-usage-operations";
import { createPostgresUsageStore } from "./postgres-usage-ledger";
import { createPostgresUsersStore } from "./postgres-user-operations";
import { createPostgresWorkspacesStore } from "./postgres-collaboration-workspace-operations";
import { createPostgresApiAccessStore } from "./postgres-api-access-operations";
import { createPostgresPersonalApiKeyStore } from "./postgres-personal-api-key-operations";
import { createPostgresAccessStore } from "./postgres-access-operations";
import { createPostgresRoleStore } from "./postgres-role-operations";
import { createPostgresConfigAssetsStore } from "./postgres-config-asset-operations";
import { createPostgresApprovalsStore } from "./postgres-approval-request-operations";
import type { TransactWithStores } from "./postgres-approval-request-operations";
import { createPostgresExecutionWorkspacesStore } from "./postgres-execution-workspace-operations";
import { createPostgresStructuredDataStore } from "./postgres-structured-data-operations";
import { createPostgresJobsStore, notifyJobsEnqueued } from "./jobs/store";
import { createPostgresOperationRunsStore } from "./postgres-operation-run-operations";
import { createPostgresLiveOnceSwitchesStore } from "./postgres-live-once-switch-operations";
import { createPostgresWorkflowStepPinsStore } from "./postgres-workflow-step-pin-operations";
import { createPostgresCapabilityRecordStore } from "./postgres-capability-record-operations";
import { createPostgresUserOperationSettingsStore } from "./postgres-user-operation-settings";
import { createPostgresAgentProposalStore } from "./postgres-agent-proposal-operations";
import { createPostgresAgentTryConversationStore } from "./postgres-agent-try-conversation-operations";
import { createPostgresInfrastructureChecksStore } from "./postgres-infrastructure-check-operations";
import { createPostgresPagesStore } from "./postgres-page-operations";
import { createPostgresConnectionsStore } from "./postgres-connection-operations";
import { createPostgresDataStoreRecordsStore } from "./postgres-data-store-operations";
import { createPostgresGuardrailsStore } from "./postgres-guardrail-operations";
import { createPostgresKnowledgeBaseStateStore } from "./postgres-knowledge-base-operations";
import {
  createPostgresWorkflowRunDatasetsStore,
  createPostgresWorkflowRunsStore
} from "./postgres-workflow-run-operations";

export interface PostgresStoresOptions {
  databaseUrl: string;
  /** Connections the pool keeps at most. Left out, the driver's own default applies. */
  poolSize?: number;
  logger?: Logger;
  /**
   * Told the text of every statement the stores send, as it is sent. For a test that holds a
   * path to a number of statements; nothing in an assembled instance sets it.
   */
  onStatement?(statement: string): void;
}

export interface PostgresStores extends PlatformStores {
  close(): Promise<void>;
  readiness(): Promise<DatabaseReadiness>;
}

export { createPostgresJobWorker, type CreatePostgresJobWorkerInput } from "./jobs/worker";
export { DatabaseBehindError, migrateDatabase, type MigrateDatabaseInput } from "./migrations";
export {
  inspectCapabilityRecordsAccess,
  type CapabilityRecordsAccess
} from "./capability-records-access";
export { READINESS_DATABASE_TIMEOUT_MS } from "./readiness";
export { ERASED_PERSON_COPIES, KEPT_LABEL_COLUMNS } from "./postgres-account-erasure";

function handlePostgresNotice(notice: Notice, logger?: Logger): void {
  if (
    (notice.code === "42P07" || notice.code === "42P06") &&
    notice.message?.includes("already exists, skipping")
  )
    return;
  logger?.warn({ notice }, "Postgres notice");
}

/**
 * `enqueued` hears of every job the stores insert. `inTransaction` is false for the stores of
 * the connection itself, whose `transaction` tells the workers of this process once it committed.
 */
function bindStores(
  db: PostgresConnection,
  enqueued: () => void = () => notifyJobsEnqueued(db),
  inTransaction = false
): PlatformStores {
  const transact: TransactWithStores = async (fn) => {
    // A nested transaction reports to the outermost one: nothing is visible before that commits.
    if (inTransaction) return db.transaction((tx) => fn(tx, bindStores(tx, enqueued, true)));
    let enqueuedInside = false;
    const noteEnqueued = () => {
      enqueuedInside = true;
    };
    const result = await db.transaction((tx) => fn(tx, bindStores(tx, noteEnqueued, true)));
    if (enqueuedInside) notifyJobsEnqueued(db);
    return result;
  };
  return {
    conversations: createPostgresConversationsStore(db, {
      listConversationsForWorkspace: (input) => listPostgresConversationsForWorkspace(db, input),
      listConversationsWithActiveRun: (input) => listPostgresConversationsWithActiveRun(db, input),
      searchWorkspaceFiles: (input) => searchPostgresWorkspaceFiles(db, input),
      deleteModelProviderContinuation: (input) =>
        deletePostgresModelProviderContinuation(db, input),
      getModelProviderContinuation: (input) => getPostgresModelProviderContinuation(db, input),
      getModelProviderTurnContinuation: (input) =>
        getPostgresModelProviderTurnContinuation(db, input),
      listExpiredConversations: (input) => listExpiredConversations(db, input),
      expireConversation: (input) => expireConversation(db, input)
    }),
    followUps: createPostgresFollowUpStore(db, { lockActiveConversation, enqueued }),
    scheduledStarts: createPostgresScheduledStartsStore(db),
    agentRuns: createPostgresAgentRunsStore(db, enqueued),
    childAgentRuns: createPostgresChildAgentRunStore(db, enqueued),
    files: createPostgresFilesStore(db, enqueued),
    audit: createPostgresAuditStore(db),
    usage: createPostgresUsageStore(db),
    users: createPostgresUsersStore(db),
    userOperationSettings: createPostgresUserOperationSettingsStore(db),
    workspaces: createPostgresWorkspacesStore(db, {
      deleteWorkspace: (input) => deletePostgresWorkspace(db, input),
      getWorkspaceInDeletion: (input) => getPostgresWorkspaceInDeletion(db, input),
      lockWorkspacesForOwnerChange: (input) => lockPostgresWorkspacesForOwnerChange(db, input),
      markWorkspaceDeletionRequested: (input) => markPostgresWorkspaceDeletionRequested(db, input)
    }),
    apiAccess: createPostgresApiAccessStore(db),
    personalApiKeys: createPostgresPersonalApiKeyStore(db),
    access: createPostgresAccessStore(db, inTransaction),
    roles: createPostgresRoleStore(db),
    configAssets: createPostgresConfigAssetsStore(
      db,
      {
        getConfigAssetPageOrigin: (input) => getPostgresConfigAssetPageOrigin(db, input),
        listConfigAssetsFromPage: (input) => listPostgresConfigAssetsFromPage(db, input),
        listConfigAssetPage: (input) => listPostgresConfigAssetPage(db, input),
        listAgentAvailability: (input) => listPostgresAgentAvailability(db, input),
        agentAwaitsFirstPublish: (input) => postgresAgentAwaitsFirstPublish(db, input),
        setAgentAvailability: (input) => setPostgresAgentAvailability(db, input),
        listAgentUseLimits: (input) => listPostgresAgentUseLimits(db, input),
        setAgentUse: (input) => setPostgresAgentUse(db, input),
        listPersonalChatSkills: (input) => listPostgresPersonalChatSkills(db, input),
        setPersonalChatSkill: (input) => setPostgresPersonalChatSkill(db, input)
      },
      inTransaction
    ),
    agentProposals: createPostgresAgentProposalStore(db),
    agentTryConversations: createPostgresAgentTryConversationStore(db),
    approvals: createPostgresApprovalsStore(db, transact),
    noticeMail: createPostgresNoticeMailStore(db),
    workflowNotices: createPostgresWorkflowNoticesStore(db),
    executionWorkspaces: createPostgresExecutionWorkspacesStore(db),
    structuredData: createPostgresStructuredDataStore(db),
    jobs: createPostgresJobsStore(db, enqueued),
    operationRuns: createPostgresOperationRunsStore(db, enqueued),
    liveOnceSwitches: createPostgresLiveOnceSwitchesStore(db),
    capabilityRecords: createPostgresCapabilityRecordStore(db),
    infrastructureChecks: createPostgresInfrastructureChecksStore(db),
    pages: createPostgresPagesStore(db),
    connections: createPostgresConnectionsStore(db),
    workflowRuns: createPostgresWorkflowRunsStore(db),
    workflowStepPins: createPostgresWorkflowStepPinsStore(db),
    workflowRunDatasets: createPostgresWorkflowRunDatasetsStore(db),
    dataStores: createPostgresDataStoreRecordsStore(db),
    knowledgeBases: createPostgresKnowledgeBaseStateStore(db),
    guardrails: createPostgresGuardrailsStore(db),
    feedback: createPostgresFeedbackStore(db),
    platformReports: createPostgresPlatformReportStore(db),
    projects: createPostgresProjectStore(db),
    projectFiles: createPostgresProjectFileStore(db),
    transaction: (fn) => transact((_tx, stores) => fn(stores)),
    // Under read committed every statement reads its own moment; repeatable read gives the
    // whole transaction the moment of its first read. Only the outermost transaction sets it.
    readSnapshot: (fn) =>
      db.transaction(async (tx) => {
        if (!inTransaction)
          await tx.setTransaction({ isolationLevel: "repeatable read", accessMode: "read only" });
        return fn(bindStores(tx, enqueued, true));
      })
  };
}

/**
 * Connects to a migrated database. It runs no DDL: a database that lacks committed migrations
 * stops the caller with their names, and `migrateDatabase` is the step that applies them.
 */
export async function createPostgresStores(
  options: PostgresStoresOptions
): Promise<PostgresStores> {
  const sql = postgres(options.databaseUrl, {
    ...(options.poolSize === undefined ? {} : { max: options.poolSize }),
    idle_timeout: 30,
    onnotice: (notice) => handlePostgresNotice(notice, options.logger)
  });
  const { onStatement } = options;
  const db = drizzle(sql, {
    schema,
    ...(onStatement ? { logger: { logQuery: (statement) => onStatement(statement) } } : {})
  });
  const stores: PostgresStores = {
    ...bindStores(db),
    close: () => sql.end(),
    readiness: createDatabaseReadinessCheck(sql, options.logger)
  };
  try {
    await assertDatabaseMigrated(sql);
    return stores;
  } catch (error) {
    await sql.end();
    throw error;
  }
}

/**
 * The capability records alone, on a connection of their own (ADR-0033): what a capability's
 * own process opens, such as the outside form's public host, which reaches no other store.
 * `access` says what the connection's role may reach besides the records of `capability`;
 * the process decides whether it starts with that.
 */
export async function createPostgresCapabilityRecords(
  options: Omit<PostgresStoresOptions, "onStatement"> & { capability: string }
): Promise<{
  records: CapabilityRecordStore;
  access: CapabilityRecordsAccess;
  close(): Promise<void>;
}> {
  const sql = postgres(options.databaseUrl, {
    max: options.poolSize ?? 4,
    idle_timeout: 30,
    onnotice: (notice) => handlePostgresNotice(notice, options.logger)
  });
  const db = drizzle(sql, { schema });
  try {
    const access = await inspectCapabilityRecordsAccess(sql, options.capability);
    return { records: createPostgresCapabilityRecordStore(db), access, close: () => sql.end() };
  } catch (error) {
    await sql.end();
    throw error;
  }
}
