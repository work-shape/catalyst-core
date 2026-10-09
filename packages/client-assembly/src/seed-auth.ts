import {
  getClientInstanceId,
  loadClientInstanceConfigFromFile,
  type ClientInstanceConfig
} from "@vivd-catalyst/config-schema";
import { AppError, type SecretResolver } from "@vivd-catalyst/core";
import { createStandaloneAuthRuntimeForClientInstance, resolveTrustedOrigins } from "./auth";
import type { ClientInstanceEnv } from "./env";
import { createEnvironmentSecrets } from "./infrastructure";
import { createPlatformStore } from "./store";

export interface SeedStandaloneAuthInput {
  config?: ClientInstanceConfig;
  configPath?: string;
  env?: ClientInstanceEnv;
  /** Replaces the `environment` secret provider. For tests. */
  secrets?: SecretResolver;
  allowedOrigins?: string | string[];
}

export interface SeedStandaloneAuthResult {
  seededUserCount: number;
}

export async function seedStandaloneAuth(
  input: SeedStandaloneAuthInput
): Promise<SeedStandaloneAuthResult> {
  const env = input.env ?? process.env;
  const config = input.config ?? (await loadConfig(input.configPath));
  if (!config.auth.standalone?.enabled) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Standalone auth is not enabled for this client instance"
    );
  }

  const secrets = input.secrets ?? createEnvironmentSecrets(env);
  const store = await createPlatformStore({ secrets });

  try {
    const authRuntime = await createStandaloneAuthRuntimeForClientInstance({
      config,
      env,
      secrets,
      clientInstanceId: getClientInstanceId(config),
      allowedOrigins: resolveTrustedOrigins({ config, env, allowedOrigins: input.allowedOrigins })
    });
    try {
      return {
        seededUserCount: config.auth.standalone?.seedUsers.length ?? 0
      };
    } finally {
      await authRuntime.close();
    }
  } finally {
    await store.close?.();
  }
}

async function loadConfig(configPath: string | undefined): Promise<ClientInstanceConfig> {
  if (!configPath) {
    throw new AppError("VALIDATION_FAILED", "A client instance config path is required");
  }
  return loadClientInstanceConfigFromFile(configPath);
}
