import { AppError } from "@vivd-catalyst/core";
import { migrateDatabase } from "@vivd-catalyst/postgres-store";
import type { ClientInstanceEnv } from "./env";

/**
 * The explicit migration step of a client instance. It applies the committed platform migrations
 * to the instance database and returns the names it applied. Nothing else migrates: the API and
 * the workers only read migration state when they start.
 */
export async function migrateClientInstanceDatabase(input: {
  env: ClientInstanceEnv;
}): Promise<string[]> {
  const databaseUrl = input.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new AppError("VALIDATION_FAILED", "DATABASE_URL is required to migrate the database");
  }
  return migrateDatabase({ databaseUrl });
}
