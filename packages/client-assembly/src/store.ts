import { createLogger } from "./logger";
import { createPostgresStores } from "@vivd-catalyst/postgres-store";
import type { Logger, PlatformStores, SecretResolver } from "@vivd-catalyst/core";
import type { ClientInstanceEnv } from "./env";
import { createEnvironmentSecrets, PLATFORM_SECRET_NAMES } from "./infrastructure";

/**
 * Opens the platform store. The database address is a secret and comes from the resolver; a
 * caller without one passes its environment and gets the `environment` secret provider.
 */
export async function createPlatformStore(input: {
  env?: ClientInstanceEnv;
  secrets?: SecretResolver;
  /** `infrastructure.database.poolSize` of the instance config. */
  poolSize: number;
  logger?: Logger;
}): Promise<PlatformStores> {
  const secrets = input.secrets ?? createEnvironmentSecrets(input.env ?? {});
  return createPostgresStores({
    databaseUrl: await secrets.resolve(PLATFORM_SECRET_NAMES.databaseUrl),
    poolSize: input.poolSize,
    logger: input.logger ?? createLogger()
  });
}
