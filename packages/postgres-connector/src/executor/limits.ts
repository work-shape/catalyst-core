/**
 * The ceilings that protect a database the customer also uses for other work. A caller may
 * lower each of them and can never raise one.
 */
export const POSTGRES_POOL_MAX_CONNECTIONS = 4;
export const POSTGRES_POOL_IDLE_CLOSE_SECONDS = 60;
export const POSTGRES_POOL_ACQUIRE_WAIT_MS = 5_000;
export const POSTGRES_STATEMENT_TIMEOUT_MS = 15_000;
/** How long after the statement timeout the platform's own timer cancels the query. */
export const POSTGRES_DEADLINE_GRACE_MS = 1_000;
export const POSTGRES_RESULT_MAX_ROWS = 1_000;
export const POSTGRES_RESULT_MAX_BYTES = 2_097_152;
export const POSTGRES_QUERY_TEXT_MAX_CHARS = 20_000;
export const POSTGRES_PARAMETERS_MAX_COUNT = 100;
export const POSTGRES_PRIVILEGE_OBJECTS_MAX_LISTED = 200;
/** Rows fetched from the cursor per round trip. The caps are checked after each batch. */
export const POSTGRES_CURSOR_BATCH_ROWS = 100;

/** The limits a caller may lower for one database. */
export interface PostgresLimits {
  maxConnections?: number;
  statementTimeoutMs?: number;
  maxRows?: number;
  maxBytes?: number;
}

export type ResolvedPostgresLimits = Required<PostgresLimits>;

export function resolvePostgresLimits(limits: PostgresLimits = {}): ResolvedPostgresLimits {
  return {
    maxConnections: lowered(limits.maxConnections, POSTGRES_POOL_MAX_CONNECTIONS),
    statementTimeoutMs: lowered(limits.statementTimeoutMs, POSTGRES_STATEMENT_TIMEOUT_MS),
    maxRows: lowered(limits.maxRows, POSTGRES_RESULT_MAX_ROWS),
    maxBytes: lowered(limits.maxBytes, POSTGRES_RESULT_MAX_BYTES)
  };
}

/** A requested limit counts between one and the ceiling. Anything else is the ceiling. */
function lowered(requested: number | undefined, ceiling: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return ceiling;
  return Math.min(ceiling, Math.max(1, Math.trunc(requested)));
}
