import { createLogger } from "./logger";
import { createPostgresStores } from "@vivd-catalyst/postgres-store";
import { AppError, type PlatformStores, type Logger } from "@vivd-catalyst/core";
import type { ClientInstanceEnv } from "./env";

export async function createPlatformStore(input: {
  env: ClientInstanceEnv;
  logger?: Logger;
}): Promise<PlatformStores> {
  if (input.env.DATABASE_URL) {
    return createPostgresStores({
      databaseUrl: input.env.DATABASE_URL,
      logger: input.logger ?? createLogger()
    });
  }

  throw new AppError("VALIDATION_FAILED", "DATABASE_URL is required for the platform store");
}
