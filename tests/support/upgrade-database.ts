import { readFile } from "node:fs/promises";
import postgres from "postgres";
import {
  createPostgresStores,
  migrateDatabase,
  type PostgresStores
} from "@vivd-catalyst/postgres-store";
import type { PostgresFixtures } from "./postgres-fixtures";

/**
 * A database as an instance of an older release left it, brought to this commit by the explicit
 * migration step: built from that release's migrations, filled with its committed fixture, then
 * migrated. Returns the names the upgrade applied and the stores that read the result.
 */
export async function upgradeFixtureDatabase(input: {
  fixtures: PostgresFixtures;
  releaseMigrationsDirectory: string;
  fixtureFile: string;
}): Promise<{ applied: string[]; stores: PostgresStores; close(): Promise<void> }> {
  const databaseUrl = await input.fixtures.database(`upgrade:${input.fixtureFile}`, false);
  try {
    await migrateDatabase({ databaseUrl, migrationsDirectory: input.releaseMigrationsDirectory });
    const sql = postgres(databaseUrl, { max: 1, onnotice() {} });
    try {
      await sql.unsafe(await readFile(input.fixtureFile, "utf8"));
    } finally {
      await sql.end();
    }
    const applied = await migrateDatabase({ databaseUrl });
    const stores = await createPostgresStores({ databaseUrl });
    return {
      applied,
      stores,
      async close() {
        await stores.close();
        await input.fixtures.drop(databaseUrl);
      }
    };
  } catch (error) {
    await input.fixtures.drop(databaseUrl);
    throw error;
  }
}
