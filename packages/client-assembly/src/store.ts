import { InMemoryPlatformStore } from "@vivd-stage/core/testing";
import { PostgresPlatformStore } from "@vivd-stage/postgres-store";
import { AppError, type PlatformStore } from "@vivd-stage/core";
import type { ClientInstanceEnv } from "./env";

export type PlatformStoreMode = "postgres" | "memory";

export async function createPlatformStore(input: {
  env: ClientInstanceEnv;
  storeMode?: PlatformStoreMode;
}): Promise<PlatformStore> {
  const mode = input.storeMode ?? resolveStoreMode(input.env);
  if (mode === "memory") {
    return new InMemoryPlatformStore();
  }

  if (input.env.DATABASE_URL) {
    return PostgresPlatformStore.connect({
      databaseUrl: input.env.DATABASE_URL,
      runMigrations: input.env.RUN_MIGRATIONS !== "false"
    });
  }

  throw new AppError(
    "VALIDATION_FAILED",
    "DATABASE_URL is required for the platform store; set STORE=memory only for explicit local/test memory mode"
  );
}

function resolveStoreMode(env: ClientInstanceEnv): PlatformStoreMode {
  if (!env.STORE) {
    return "postgres";
  }
  if (env.STORE === "memory" || env.STORE === "postgres") {
    return env.STORE;
  }
  throw new AppError("VALIDATION_FAILED", "STORE must be either 'postgres' or 'memory'");
}
