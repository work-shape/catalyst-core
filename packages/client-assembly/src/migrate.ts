import { migrateDatabase } from "@vivd-catalyst/postgres-store";
import type { ClientInstanceEnv } from "./env";
import { createEnvironmentSecrets, PLATFORM_SECRET_NAMES } from "./infrastructure";

/**
 * The explicit migration step of a client instance. It applies the committed platform migrations
 * to the instance database and returns the names it applied. Nothing else migrates: the API and
 * the workers only read migration state when they start.
 */
export async function migrateClientInstanceDatabase(input: {
  env: ClientInstanceEnv;
}): Promise<string[]> {
  const databaseUrl = await createEnvironmentSecrets(input.env).resolve(
    PLATFORM_SECRET_NAMES.databaseUrl
  );
  return migrateDatabase({ databaseUrl });
}
