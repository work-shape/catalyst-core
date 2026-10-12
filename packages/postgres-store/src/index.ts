import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Notice } from "postgres";
import type { DatabaseReadiness, Logger, PlatformStores } from "@vivd-catalyst/core";
import type { PostgresConnection } from "./postgres-database";
import { assertDatabaseMigrated } from "./migrations";
import { createDatabaseReadinessCheck } from "./readiness";
import { schema } from "./schema";
import { createPostgresConversationsStore } from "./stores/conversations";
import { createPostgresAgentRunsStore } from "./stores/agentRuns";
import { createPostgresFilesStore } from "./stores/files";
import { createPostgresAuditStore } from "./stores/audit";
import { createPostgresUsageStore } from "./stores/usage";
import { createPostgresUsersStore } from "./stores/users";
import { createPostgresWorkspacesStore } from "./stores/workspaces";
import { createPostgresApiAccessStore } from "./stores/apiAccess";
import { createPostgresAccessStore } from "./stores/access";
import { createPostgresConfigAssetsStore } from "./stores/configAssets";
import { createPostgresApprovalsStore } from "./stores/approvals";
import type { TransactWithStores } from "./postgres-approval-request-operations";
import { createPostgresExecutionWorkspacesStore } from "./stores/executionWorkspaces";
import { createPostgresStructuredDataStore } from "./stores/structuredData";
import { createPostgresJobsStore, notifyJobsEnqueued } from "./jobs/store";
import { createPostgresOperationRunsStore } from "./stores/operationRuns";
import { createPostgresInfrastructureChecksStore } from "./stores/infrastructure";
import { createPostgresPagesStore } from "./stores/pages";
import { createPostgresConnectionsStore } from "./stores/connections";
import { createPostgresDataStoreRecordsStore } from "./stores/data-stores";
import { createPostgresWorkflowRunsStore } from "./stores/workflow-runs";

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
    conversations: createPostgresConversationsStore(db),
    agentRuns: createPostgresAgentRunsStore(db, enqueued),
    files: createPostgresFilesStore(db, enqueued),
    audit: createPostgresAuditStore(db),
    usage: createPostgresUsageStore(db),
    users: createPostgresUsersStore(db),
    workspaces: createPostgresWorkspacesStore(db),
    apiAccess: createPostgresApiAccessStore(db),
    access: createPostgresAccessStore(db),
    configAssets: createPostgresConfigAssetsStore(db),
    approvals: createPostgresApprovalsStore(db, transact),
    executionWorkspaces: createPostgresExecutionWorkspacesStore(db),
    structuredData: createPostgresStructuredDataStore(db),
    jobs: createPostgresJobsStore(db, enqueued),
    operationRuns: createPostgresOperationRunsStore(db),
    infrastructureChecks: createPostgresInfrastructureChecksStore(db),
    pages: createPostgresPagesStore(db),
    connections: createPostgresConnectionsStore(db),
    workflowRuns: createPostgresWorkflowRunsStore(db),
    dataStores: createPostgresDataStoreRecordsStore(db),
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
