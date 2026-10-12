import { z } from "zod";
import type { DataStoreAppliedMigration, DataStoreRecord } from "@vivd-catalyst/core";
import type { DataStoreMigration } from "./definition";
import { DATA_STORE_ROLE_LIMITS } from "./provisioning";
import type { DataStoreServer } from "./server";

/** How long reading the applied migrations of a store may take before the attempt fails. */
const DATA_STORE_LEVEL_READ_TIMEOUT_MS = 15_000;

const appliedSchema = z.array(
  z.object({ number: z.number().int(), name: z.string(), sha256: z.string() })
);

/** The migrations a store's database has applied, as the database itself recorded them. */
export function readAppliedMigrations(
  server: DataStoreServer,
  record: Pick<DataStoreRecord, "id" | "location" | "roles">,
  signal: AbortSignal
): Promise<DataStoreAppliedMigration[]> {
  return server.executor.change(
    {
      ...server.asRole(record, "migration"),
      timeoutMs: DATA_STORE_LEVEL_READ_TIMEOUT_MS,
      signal
    },
    async (sql) =>
      appliedSchema.parse(
        await sql.run("select number, name, sha256 from catalyst.migrations order by number")
      )
  );
}

/**
 * Applies one migration as the migration role: the file's statements and the row that records
 * it, in one transaction. Either both are there afterwards or neither is, so a migration is
 * never applied twice and never recorded without its effect.
 */
export async function applyMigration(
  server: DataStoreServer,
  record: Pick<DataStoreRecord, "id" | "location" | "roles">,
  migration: DataStoreMigration,
  signal: AbortSignal
): Promise<void> {
  await server.executor.change(
    {
      ...server.asRole(record, "migration"),
      timeoutMs: DATA_STORE_ROLE_LIMITS.migration.statementTimeoutMs,
      signal
    },
    async (sql) => {
      await sql.script(migration.sql);
      await sql.run("insert into catalyst.migrations (number, name, sha256) values ($1, $2, $3)", [
        { type: "integer", value: migration.number },
        migration.name,
        migration.sha256
      ]);
    }
  );
}
