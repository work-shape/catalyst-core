import { tmpdir } from "node:os";
import { AppError } from "@vivd-catalyst/core";
import {
  getClientInstanceId,
  loadClientInstanceConfigFromFile,
  type ClientInstanceConfig
} from "@vivd-catalyst/config-schema";
import {
  createDockerProcessExecutorFromConfig,
  createLocalWorkspaceFileByteStore,
  LocalWorkspaceCommandProcessExecutor,
  LocalWorkspaceCommandRunner,
  WorkspaceCommandWorker
} from "@vivd-catalyst/tool-execution";
import type { ClientInstanceEnv } from "./env";
import { createPlatformStore, type PlatformStoreMode } from "./store";

export interface CreateClientInstanceWorkspaceCommandWorkerInput {
  config?: ClientInstanceConfig;
  configPath?: string;
  env?: ClientInstanceEnv;
  storeMode?: PlatformStoreMode;
}

export interface ClientInstanceWorkspaceCommandWorker {
  readonly config: ClientInstanceConfig;
  readonly worker: WorkspaceCommandWorker;
  runUntilStopped(): Promise<void>;
  stop(input?: { cancelActive?: boolean; reason?: string }): Promise<void>;
  close(): Promise<void>;
}

export async function createClientInstanceWorkspaceCommandWorker(
  input: CreateClientInstanceWorkspaceCommandWorkerInput = {}
): Promise<ClientInstanceWorkspaceCommandWorker> {
  const env = input.env ?? process.env;
  const config = input.config ?? (await loadWorkspaceWorkerConfig(input.configPath, env));
  if (!config.executionWorkspaces.enabled) {
    throw new AppError("VALIDATION_FAILED", "Execution workspaces are disabled in release config");
  }

  const store = await createPlatformStore({ env, storeMode: input.storeMode });
  const clientInstanceId = getClientInstanceId(config);
  const byteStore = createLocalWorkspaceFileByteStore({
    rootDirectory: requiredEnv(env, "EXECUTION_WORKSPACE_OBJECT_ROOT")
  });
  const processExecutor =
    config.executionWorkspaces.runner.mode === "docker"
      ? createDockerProcessExecutorFromConfig(config.executionWorkspaces.runner)
      : new LocalWorkspaceCommandProcessExecutor();
  const runner = new LocalWorkspaceCommandRunner({
    store,
    byteStore,
    tempRootDirectory: env.WORKSPACE_COMMAND_TEMP_ROOT ?? tmpdir(),
    leaseDurationMs: config.executionWorkspaces.worker.leaseDurationMs,
    processExecutor
  });
  const worker = new WorkspaceCommandWorker({
    clientInstanceId,
    store,
    runner,
    workerId: env.WORKSPACE_COMMAND_WORKER_ID,
    ...config.executionWorkspaces.worker
  });

  return {
    config,
    worker,
    runUntilStopped() {
      return worker.runUntilStopped();
    },
    stop(stopInput = {}) {
      return worker.stop(stopInput);
    },
    async close() {
      await store.close?.();
    }
  };
}

export async function runClientInstanceWorkspaceCommandWorker(
  input: CreateClientInstanceWorkspaceCommandWorkerInput = {}
): Promise<void> {
  const service = await createClientInstanceWorkspaceCommandWorker(input);
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) {
      return;
    }
    stopping = true;
    service
      .stop({
        cancelActive: true,
        reason: `Received ${signal}`
      })
      .catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
      });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await service.runUntilStopped();
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await service.close();
  }
}

async function loadWorkspaceWorkerConfig(
  configPath: string | undefined,
  env: ClientInstanceEnv
): Promise<ClientInstanceConfig> {
  const resolvedPath = configPath ?? env.CLIENT_CONFIG_PATH;
  if (!resolvedPath) {
    throw new AppError(
      "VALIDATION_FAILED",
      "CLIENT_CONFIG_PATH is required when config is not passed explicitly"
    );
  }
  return loadClientInstanceConfigFromFile(resolvedPath);
}

function requiredEnv(env: ClientInstanceEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new AppError("VALIDATION_FAILED", `${name} is required for workspace command workers`);
  }
  return value;
}
