import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Notice } from "postgres";
import type { Logger, PlatformStores } from "@vivd-catalyst/core";
import type { PostgresConnection } from "./postgres-database";
import { runPostgresMigrations } from "./migrations";
import { schema } from "./schema";
import { createPostgresConversationsStore } from "./stores/conversations";
import { createPostgresAgentRunsStore } from "./stores/agentRuns";
import { createPostgresFilesStore } from "./stores/files";
import { createPostgresAuditStore } from "./stores/audit";
import { createPostgresUsageStore } from "./stores/usage";
import { createPostgresUsersStore } from "./stores/users";
import { createPostgresWorkspacesStore } from "./stores/workspaces";
import { createPostgresApiAccessStore } from "./stores/apiAccess";
import { createPostgresConfigAssetsStore } from "./stores/configAssets";
import { createPostgresApprovalsStore } from "./stores/approvals";
import { createPostgresExecutionWorkspacesStore } from "./stores/executionWorkspaces";
import { createPostgresStructuredDataStore } from "./stores/structuredData";

export interface PostgresStoresOptions {
  databaseUrl: string;
  logger?: Logger;
  runMigrations?: boolean;
}

export interface PostgresStores extends PlatformStores {
  close(): Promise<void>;
  migrate(): Promise<void>;
}

function handlePostgresNotice(notice: Notice, logger?: Logger): void {
  if (
    (notice.code === "42P07" || notice.code === "42P06") &&
    notice.message?.includes("already exists, skipping")
  )
    return;
  logger?.warn({ notice }, "Postgres notice");
}

function bindStores(db: PostgresConnection): PlatformStores {
  return {
    conversations: createPostgresConversationsStore(db),
    agentRuns: createPostgresAgentRunsStore(db),
    files: createPostgresFilesStore(db),
    audit: createPostgresAuditStore(db),
    usage: createPostgresUsageStore(db),
    users: createPostgresUsersStore(db),
    workspaces: createPostgresWorkspacesStore(db),
    apiAccess: createPostgresApiAccessStore(db),
    configAssets: createPostgresConfigAssetsStore(db),
    approvals: createPostgresApprovalsStore(db),
    executionWorkspaces: createPostgresExecutionWorkspacesStore(db),
    structuredData: createPostgresStructuredDataStore(db),
    transaction: (fn) => db.transaction((tx) => fn(bindStores(tx)))
  };
}

export async function createPostgresStores(
  options: PostgresStoresOptions
): Promise<PostgresStores> {
  const sql = postgres(options.databaseUrl, {
    max: 10,
    idle_timeout: 30,
    onnotice: (notice) => handlePostgresNotice(notice, options.logger)
  });
  const db = drizzle(sql, { schema });
  const stores: PostgresStores = {
    ...bindStores(db),
    close: () => sql.end(),
    migrate: () => runPostgresMigrations(sql, db, options.logger)
  };
  try {
    if (options.runMigrations ?? true) await stores.migrate();
    return stores;
  } catch (error) {
    await sql.end();
    throw error;
  }
}
