import {
  AppError,
  isAppError,
  type DataStoreRecord,
  type DataStoreRecordsRule
} from "@work-shape/catalyst-core";
import type { PostgresChangeStatements } from "@work-shape/catalyst-postgres-connector";
import { readKeyIndexesIn } from "../catalog";
import type { DataStoreServer } from "../server";

// A catalog outage cannot hold a publish indefinitely; it fails and the caller may retry.
const RECORDS_CATALOG_TIMEOUT_MS = 15_000;

/** Check the real schema, including uncommitted DDL when called by the migration. */
export async function checkRecordsKeys(
  sql: Pick<PostgresChangeStatements, "run">,
  rules: readonly DataStoreRecordsRule[] | undefined
): Promise<void> {
  for (const rule of rules ?? []) {
    if (!(await readKeyIndexesIn(sql, rule.table, [rule.key.column])).length) {
      throw new AppError(
        "VALIDATION_FAILED",
        `'records.${rule.table}.key.${rule.key.column}': table '${rule.table}' must exist and column '${rule.key.column}' must have a valid, non-partial, non-deferrable unique key by itself.`,
        { reason: "record_key_invalid", table: rule.table, field: rule.key.column }
      );
    }
  }
}

/** A revision without pending DDL must already meet its rules. Pending DDL is checked at commit. */
export async function checkRecordsCatalog(
  server: DataStoreServer,
  current: DataStoreRecord | undefined,
  rules: readonly DataStoreRecordsRule[] | undefined
): Promise<void> {
  if (!rules?.length) return;
  if (!current || current.status !== "ready") {
    const rule = rules[0];
    if (rule)
      throw new AppError(
        "VALIDATION_FAILED",
        `'records.${rule.table}.key.${rule.key.column}': publish a migration that creates the table and unique key.`,
        { reason: "record_key_invalid", table: rule.table, field: rule.key.column }
      );
    return;
  }
  const refusal = await server.executor.change(
    {
      ...server.asPlatform(current.location.database),
      timeoutMs: RECORDS_CATALOG_TIMEOUT_MS,
      signal: AbortSignal.timeout(RECORDS_CATALOG_TIMEOUT_MS)
    },
    async (sql) => {
      // Executor failures are database errors. Return our validation refusal so it is
      // raised outside that boundary and keeps its HTTP status and named field.
      try {
        await checkRecordsKeys(sql, rules);
      } catch (error) {
        if (isAppError(error)) return error;
        throw error;
      }
      return undefined;
    }
  );
  if (refusal) throw refusal;
}
