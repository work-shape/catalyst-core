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
