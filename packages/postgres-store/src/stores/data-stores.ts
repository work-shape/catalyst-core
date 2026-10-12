import type { DataStoreRecordsStore } from "@vivd-catalyst/core";
import type { PostgresConnection } from "../postgres-database";

/** The record of each Data Store. It holds nothing until the store has its tables. */
export function createPostgresDataStoreRecordsStore(
  _db: PostgresConnection
): DataStoreRecordsStore {
  return {};
}
