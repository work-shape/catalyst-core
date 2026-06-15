import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Sql } from "postgres";
import type { schema } from "./schema";

type PostgresDatabase = PostgresJsDatabase<typeof schema>;

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../migrations");
const migrationLockKey = "vivd-catalyst:postgres-store:migrations";

export async function runPostgresMigrations(sql: Sql, db: PostgresDatabase): Promise<void> {
  const reserved = await sql.reserve();
  let migrationError: unknown;

  try {
    await acquireMigrationLock(reserved);
    await migrate(db, {
      migrationsFolder,
      migrationsSchema: "drizzle",
      migrationsTable: "__drizzle_migrations"
    });
  } catch (error) {
    migrationError = error;
    throw error;
  } finally {
    try {
      await releaseMigrationLock(reserved);
    } catch (error) {
      if (!migrationError) {
        throw error;
      }
      console.warn("Failed to release Postgres migration advisory lock", error);
    } finally {
      reserved.release();
    }
  }
}

async function acquireMigrationLock(sql: Sql): Promise<void> {
  await sql`select pg_advisory_lock(hashtextextended(${migrationLockKey}, 0))`;
}

async function releaseMigrationLock(sql: Sql): Promise<void> {
  await sql`select pg_advisory_unlock(hashtextextended(${migrationLockKey}, 0))`;
}
