import {
  getClientInstanceId,
  loadClientInstanceConfigFromFile,
  type ClientInstanceConfig
} from "@vivd-catalyst/config-schema";
import { AppError } from "@vivd-catalyst/core";
import { createStandaloneAuthRuntimeForClientInstance } from "./auth";
import type { ClientInstanceEnv } from "./env";
import { createPlatformStore } from "./store";

export interface SeedStandaloneAuthInput {
  config?: ClientInstanceConfig;
  configPath?: string;
  env?: ClientInstanceEnv;
  corsOrigin?: string | string[];
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
    throw new AppError("VALIDATION_FAILED", "Standalone auth is not enabled for this client instance");
  }

  const store = await createPlatformStore({
    env,
    storeMode: "postgres"
  });

  try {
    const authRuntime = await createStandaloneAuthRuntimeForClientInstance({
      config,
      env,
      clientInstanceId: getClientInstanceId(config),
      corsOrigin: input.corsOrigin
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
