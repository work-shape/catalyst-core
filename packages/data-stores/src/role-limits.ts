import type { DataStoreRole } from "./credentials";

/**
 * The limits Postgres itself holds each store role to: the longest statement and the number of
 * connections. A statement past its timeout is cancelled by the database and the call reports
 * a timeout; a connection past the limit is refused and the call reports the store as busy.
 */
export const DATA_STORE_ROLE_LIMITS = {
  app: { statementTimeoutMs: 15_000, connectionLimit: 10 },
  migration: { statementTimeoutMs: 600_000, connectionLimit: 2 }
} as const satisfies Record<DataStoreRole, { statementTimeoutMs: number; connectionLimit: number }>;

/** How long a session of a store role may sit idle inside a transaction before Postgres ends it. */
const DATA_STORE_IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

/**
 * The working memory a statement of a store role starts with, in kB. A role may raise it for
 * its own session, so it is a default and no bound.
 */
const DATA_STORE_WORK_MEM_KB = 16_384;

/**
 * The most temporary files a session of a store role may hold at once, in kB: 1 GiB. A
 * statement that sorts or joins beyond it fails. Only a superuser may set it, and then the
 * role cannot raise it.
 */
const DATA_STORE_TEMP_FILE_LIMIT_KB = 1_048_576;

/**
 * The settings Postgres keeps on a store role, in the order they are set: `name=value` as
 * `pg_roles.rolconfig` shows them. A role carries exactly these and nothing per database.
 * `temp_file_limit` is among them where the platform's role is a superuser, which alone may
 * set it.
 */
export function roleSettings(role: DataStoreRole, superuser: boolean): string[] {
  return [
    `statement_timeout=${DATA_STORE_ROLE_LIMITS[role].statementTimeoutMs}`,
    `idle_in_transaction_session_timeout=${DATA_STORE_IDLE_IN_TRANSACTION_TIMEOUT_MS}`,
    `work_mem=${DATA_STORE_WORK_MEM_KB}`,
    ...(superuser ? [`temp_file_limit=${DATA_STORE_TEMP_FILE_LIMIT_KB}`] : [])
  ];
}
