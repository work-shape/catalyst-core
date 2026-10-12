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
 * The settings Postgres keeps on a store role, in the order they are set: `name=value` as
 * `pg_roles.rolconfig` shows them. A role carries exactly these and nothing per database.
 */
export function roleSettings(role: DataStoreRole): string[] {
  return [
    `statement_timeout=${DATA_STORE_ROLE_LIMITS[role].statementTimeoutMs}`,
    `idle_in_transaction_session_timeout=${DATA_STORE_IDLE_IN_TRANSACTION_TIMEOUT_MS}`
  ];
}
