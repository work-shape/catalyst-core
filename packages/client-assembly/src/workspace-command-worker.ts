import { createLogger } from "./logger";
import { tmpdir } from "node:os";
import { AppError, StoreBackedAuditRecorder, type SecretResolver } from "@vivd-catalyst/core";
import {
  getClientInstanceId,
  loadClientInstanceConfigFromFile,
  type ClientInstanceConfig
} from "@vivd-catalyst/config-schema";
import {
  createConsoleWorkspaceCommandTelemetry,
  LocalWorkspaceCommandRunner,
  WorkspaceCommandWorker
} from "@vivd-catalyst/tool-execution";
import type { ClientInstanceEnv } from "./env";
import {
  createInstanceInfrastructure,
  createSandbox,
  createWorkspaceObjectStore,
  SANDBOX_PATH,
  WORKSPACE_STORE_PATH
} from "./infrastructure";
import { createPlatformStore } from "./store";

export interface CreateClientInstanceWorkspaceCommandWorkerInput {
  config?: ClientInstanceConfig;
  configPath?: string;
  env?: ClientInstanceEnv;
  /** Replaces the configured secret provider. For tests. */
  secrets?: SecretResolver;
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
  const logger = createLogger();
  const env = input.env ?? process.env;
  const config = applyWorkspaceRunnerImageEnvOverride(
    input.config ?? (await loadWorkspaceWorkerConfig(input.configPath, env)),
    env
  );
  if (!config.executionWorkspaces.enabled) {
    throw new AppError("VALIDATION_FAILED", "Execution workspaces are disabled in release config");
  }

  const infrastructure = await createInstanceInfrastructure({
    config,
    env,
    logger,
    secrets: input.secrets,
    uses: [WORKSPACE_STORE_PATH, SANDBOX_PATH]
  });
  const store = await createPlatformStore({
    secrets: infrastructure.secrets,
    poolSize: config.infrastructure.database.poolSize,
    logger
  });
  const clientInstanceId = getClientInstanceId(config);
  const byteStore = (await createWorkspaceObjectStore(config, infrastructure.context)).fileBytes;
  const auditRecorder = new StoreBackedAuditRecorder({
    clientInstanceId,
    store: store.audit
  });
  const telemetry = createConsoleWorkspaceCommandTelemetry(logger);
  const processExecutor = await createSandbox(config, infrastructure);
  const runner = new LocalWorkspaceCommandRunner({
    store,
    byteStore,
    tempRootDirectory: env.WORKSPACE_COMMAND_TEMP_ROOT ?? tmpdir(),
    leaseDurationMs: config.executionWorkspaces.worker.leaseDurationMs,
    reuseWorkspaceDirectories: config.executionWorkspaces.cleanup.hydratedWorkspaceIdleTtlMs > 0,
    processExecutor,
    auditRecorder,
    telemetry
  });
  const worker = new WorkspaceCommandWorker({
    clientInstanceId,
    store: store.executionWorkspaces,
    runner,
    workerId: env.WORKSPACE_COMMAND_WORKER_ID,
    ...config.executionWorkspaces.worker,
    tempStateCleanupIntervalMs: config.executionWorkspaces.cleanup.tempStateCleanupIntervalMs,
    hydratedWorkspaceIdleTtlMs: config.executionWorkspaces.cleanup.hydratedWorkspaceIdleTtlMs,
    auditRecorder,
    telemetry
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

/**
 * A release builds its own sandbox image, so a deployment names it per release in the variable
 * `EXECUTION_WORKSPACE_RUNNER_IMAGE`. It replaces `infrastructure.sandbox.image` of a `docker`
 * sandbox and is ignored for any other; a setting, not a secret, so it stays an environment read.
 */
export function applyWorkspaceRunnerImageEnvOverride(
  config: ClientInstanceConfig,
  env: ClientInstanceEnv
): ClientInstanceConfig {
  const image = env.EXECUTION_WORKSPACE_RUNNER_IMAGE?.trim();
  const { sandbox } = config.infrastructure;
  if (!image || sandbox?.provider !== "docker") {
    return config;
  }
  return {
    ...config,
    infrastructure: { ...config.infrastructure, sandbox: { ...sandbox, image } }
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
        createLogger().error({ error }, "Worker shutdown failed");
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
