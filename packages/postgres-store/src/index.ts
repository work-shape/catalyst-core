import {
  listAgentAvailability as listPostgresAgentAvailability,
  setAgentAvailability as setPostgresAgentAvailability
} from "./postgres-agent-availability";
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
  getModelProviderContinuation as getPostgresModelProviderContinuation
} from "./postgres-model-provider-continuation-operations";
import { searchWorkspaceFiles as searchPostgresWorkspaceFiles } from "./postgres-file-search-operations";
import {
  listConversationsForWorkspace as listPostgresConversationsForWorkspace,
  listConversationsWithActiveRun as listPostgresConversationsWithActiveRun
} from "./postgres-conversation-list-operations";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Notice } from "postgres";
import type { DatabaseReadiness, Logger, PlatformStores } from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { assertDatabaseMigrated } from "./migrations";
import { createDatabaseReadinessCheck } from "./readiness";
import { schema } from "./schema";
import { createPostgresFollowUpStore } from "./postgres-follow-up-operations";
import { lockActiveConversation } from "./postgres-conversation-operations";
import { createPostgresConversationsStore } from "./postgres-conversation-operations";
import { createPostgresAgentRunsStore } from "./postgres-agent-run-operations";
import { createPostgresFilesStore } from "./postgres-file-store";
import { createPostgresAuditStore } from "./postgres-audit-usage-operations";
import { createPostgresUsageStore } from "./postgres-usage-ledger";
import { createPostgresUsersStore } from "./postgres-user-operations";
import { createPostgresWorkspacesStore } from "./postgres-collaboration-workspace-operations";
import { createPostgresApiAccessStore } from "./postgres-api-access-operations";
import { createPostgresPersonalApiKeyStore } from "./postgres-personal-api-key-operations";
import { createPostgresAccessStore } from "./postgres-access-operations";
import { createPostgresConfigAssetsStore } from "./postgres-config-asset-operations";
import { createPostgresApprovalsStore } from "./postgres-approval-request-operations";
import type { TransactWithStores } from "./postgres-approval-request-operations";
import { createPostgresExecutionWorkspacesStore } from "./postgres-execution-workspace-operations";
import { createPostgresStructuredDataStore } from "./postgres-structured-data-operations";
import { createPostgresJobsStore, notifyJobsEnqueued } from "./jobs/store";
import { createPostgresOperationRunsStore } from "./postgres-operation-run-operations";
import { createPostgresLiveOnceSwitchesStore } from "./postgres-live-once-switch-operations";
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
export { READINESS_DATABASE_TIMEOUT_MS } from "./readiness";

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
      getModelProviderContinuation: (input) => getPostgresModelProviderContinuation(db, input)
    }),
    followUps: createPostgresFollowUpStore(db, { lockActiveConversation }),
    agentRuns: createPostgresAgentRunsStore(db, enqueued),
    files: createPostgresFilesStore(db, enqueued),
    audit: createPostgresAuditStore(db),
    usage: createPostgresUsageStore(db),
    users: createPostgresUsersStore(db),
    workspaces: createPostgresWorkspacesStore(db, {
      deleteWorkspace: (input) => deletePostgresWorkspace(db, input),
      getWorkspaceInDeletion: (input) => getPostgresWorkspaceInDeletion(db, input),
      lockWorkspacesForOwnerChange: (input) => lockPostgresWorkspacesForOwnerChange(db, input),
      markWorkspaceDeletionRequested: (input) => markPostgresWorkspaceDeletionRequested(db, input)
    }),
    apiAccess: createPostgresApiAccessStore(db),
    personalApiKeys: createPostgresPersonalApiKeyStore(db),
    access: createPostgresAccessStore(db, inTransaction),
    configAssets: createPostgresConfigAssetsStore(
      db,
      {
        getConfigAssetPageOrigin: (input) => getPostgresConfigAssetPageOrigin(db, input),
        listConfigAssetsFromPage: (input) => listPostgresConfigAssetsFromPage(db, input),
        listConfigAssetPage: (input) => listPostgresConfigAssetPage(db, input),
        listAgentAvailability: (input) => listPostgresAgentAvailability(db, input),
        setAgentAvailability: (input) => setPostgresAgentAvailability(db, input)
      },
      inTransaction
    ),
    agentProposals: createPostgresAgentProposalStore(db),
    agentTryConversations: createPostgresAgentTryConversationStore(db),
    approvals: createPostgresApprovalsStore(db, transact),
    executionWorkspaces: createPostgresExecutionWorkspacesStore(db),
    structuredData: createPostgresStructuredDataStore(db),
    jobs: createPostgresJobsStore(db, enqueued),
    operationRuns: createPostgresOperationRunsStore(db),
    liveOnceSwitches: createPostgresLiveOnceSwitchesStore(db),
    infrastructureChecks: createPostgresInfrastructureChecksStore(db),
    pages: createPostgresPagesStore(db),
    connections: createPostgresConnectionsStore(db),
    workflowRuns: createPostgresWorkflowRunsStore(db),
    workflowRunDatasets: createPostgresWorkflowRunDatasetsStore(db),
    dataStores: createPostgresDataStoreRecordsStore(db),
    knowledgeBases: createPostgresKnowledgeBaseStateStore(db),
    guardrails: createPostgresGuardrailsStore(db),
    transaction: (fn) => transact((_tx, stores) => fn(stores))
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
