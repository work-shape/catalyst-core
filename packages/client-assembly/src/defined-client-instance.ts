import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import type { ToolAssemblyDefinition } from "@vivd-catalyst/tool-sdk";
import {
  createClientInstanceApp,
  type ClientInstanceApp,
  type CreateClientInstanceAppInput
} from "./app";
import type { ClientInstanceCapability } from "./capabilities";
import type { ClientInstanceEnv } from "./env";
import {
  seedStandaloneAuth as seedStandaloneAuthCommand,
  type SeedStandaloneAuthInput,
  type SeedStandaloneAuthResult
} from "./seed-auth";

export interface DefineClientInstanceInput {
  rootDir: string | URL;
  workspaceRoot?: string | URL;
  configFile?: string;
  tools?: ToolAssemblyDefinition[];
  capabilities?: ClientInstanceCapability[];
  corsOrigin?: string | string[];
  loadEnv?: boolean;
}

export interface DefinedClientInstance {
  readonly clientRoot: string;
  readonly workspaceRoot: string;
  loadEnvironment(input?: { env?: ClientInstanceEnv }): ClientInstanceEnv;
  resolveConfigPath(input?: { env?: ClientInstanceEnv; configPath?: string }): string;
  createApp(
    input?: Omit<CreateClientInstanceAppInput, "configPath" | "tools"> & {
      configPath?: string;
    }
  ): Promise<ClientInstanceApp>;
  listen(input?: {
    env?: ClientInstanceEnv;
    host?: string;
    port?: number;
    configPath?: string;
    storeMode?: CreateClientInstanceAppInput["storeMode"];
    corsOrigin?: string | string[];
  }): Promise<ClientInstanceApp>;
  seedStandaloneAuth(input?: Omit<SeedStandaloneAuthInput, "configPath"> & {
    configPath?: string;
  }): Promise<SeedStandaloneAuthResult>;
}

export function defineClientInstance(input: DefineClientInstanceInput): DefinedClientInstance {
  const clientRoot = resolve(toPath(input.rootDir));
  const workspaceRoot = resolve(toPath(input.workspaceRoot ?? resolve(clientRoot, "../..")));
  const tools = input.tools ?? [];
  const capabilities = input.capabilities ?? [];

  function loadEnvironment(loadInput: { env?: ClientInstanceEnv } = {}): ClientInstanceEnv {
    const env = loadInput.env ?? process.env;
    if (!loadInput.env && input.loadEnv !== false) {
      loadDotenv({ path: resolve(workspaceRoot, ".env"), quiet: true });
      loadDotenv({ path: resolve(clientRoot, ".env"), override: true, quiet: true });
    }
    return env;
  }

  function resolveConfigPath(resolveInput: {
    env?: ClientInstanceEnv;
    configPath?: string;
  } = {}): string {
    const env = resolveInput.env ?? process.env;
    const configuredPath =
      resolveInput.configPath ?? env.CLIENT_CONFIG_PATH ?? input.configFile ?? "config/app.yaml";
    if (isAbsolute(configuredPath)) {
      return configuredPath;
    }

    const workspacePath = resolve(workspaceRoot, configuredPath);
    if (existsSync(workspacePath)) {
      return workspacePath;
    }
    return resolve(clientRoot, configuredPath);
  }

  async function createApp(
    appInput: Omit<CreateClientInstanceAppInput, "configPath" | "tools"> & {
      configPath?: string;
    } = {}
  ): Promise<ClientInstanceApp> {
    const env = loadEnvironment({ env: appInput.env });
    return createClientInstanceApp({
      ...appInput,
      env,
      configPath: resolveConfigPath({
        env,
        configPath: appInput.configPath
      }),
      tools,
      capabilities,
      corsOrigin: appInput.corsOrigin ?? input.corsOrigin
    });
  }

  return {
    clientRoot,
    workspaceRoot,
    loadEnvironment,
    resolveConfigPath,
    createApp,
    async listen(listenInput = {}) {
      const app = await createApp({
        env: listenInput.env,
        configPath: listenInput.configPath,
        storeMode: listenInput.storeMode,
        corsOrigin: listenInput.corsOrigin
      });
      await app.listen({
        host: listenInput.host,
        port: listenInput.port
      });
      registerShutdownHandlers(app);
      return app;
    },
    async seedStandaloneAuth(seedInput = {}) {
      const env = loadEnvironment({ env: seedInput.env });
      return seedStandaloneAuthCommand({
        ...seedInput,
        env,
        configPath: resolveConfigPath({
          env,
          configPath: seedInput.configPath
        }),
        corsOrigin: seedInput.corsOrigin ?? input.corsOrigin
      });
    }
  };
}

function toPath(value: string | URL): string {
  if (value instanceof URL) {
    return fileURLToPath(value);
  }
  if (value.startsWith("file:")) {
    return fileURLToPath(new URL(value));
  }
  return value;
}

function registerShutdownHandlers(app: ClientInstanceApp): void {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void app.close();
    });
  }
}
