import { createLogger } from "./logger";
import { tmpdir } from "node:os";
import {
  AppError,
  StoreBackedAuditRecorder,
  type JobWorker,
  type SecretResolver
} from "@vivd-catalyst/core";
import {
  getClientInstanceId,
  loadClientInstanceConfigFromFile,
  type ClientInstanceConfig
} from "@vivd-catalyst/config-schema";
import {
  createConsoleWorkspaceCommandTelemetry,
  createWorkspaceCommandJobs,
  LocalWorkspaceCommandRunner
} from "@vivd-catalyst/tool-execution";
import { assetRepoCommitJob, assetRepoSweepJob, pageBundleJob } from "@vivd-catalyst/chat-server";
import { readClientInstanceEnv, type ClientInstanceEnv } from "./env";
import {
  createInstanceInfrastructure,
  createSandbox,
  createSandboxCheckJobs,
  createWorkspacesStore,
  FILES_STORE_PATH,
  SANDBOX_PATH,
  WORKSPACE_STORE_PATH
} from "./infrastructure";
import { createJobWorker } from "./job-worker";
import type { ClientInstanceCapability } from "./capabilities";
import {
  assertCommandWorkerServesModuleJobKinds,
  endResolveOnlyRun,
  resolveInstanceModules
} from "./modules";
import {
  createInstanceAssetRepoJobs,
  createInstancePageBuildJobs,
  requireFilesStore
} from "./pages";
import { createPlatformStore } from "./store";

export interface CreateClientInstanceWorkspaceCommandWorkerInput {
  config?: ClientInstanceConfig;
  configPath?: string;
  env?: ClientInstanceEnv;
  /** The capabilities of this build, the same ones every process of the instance is given. */
  capabilities: readonly ClientInstanceCapability[];
  /** Replaces the configured secret provider. For tests. */
  secrets?: SecretResolver;
}

export interface ClientInstanceWorkspaceCommandWorker {
  readonly config: ClientInstanceConfig;
  /**
   * The job worker that serves `workspace.command` and, with the `apps` module on, `page.bundle`
   * and the commits and the sweep of asset repositories.
   */
  readonly worker: JobWorker;
  /** Starts the worker and resolves once `stop` has ended its commands. */
  runUntilStopped(): Promise<void>;
  /** Cancels the running commands, records them as cancelled and stops claiming. */
  stop(): Promise<void>;
  close(): Promise<void>;
}

export async function createClientInstanceWorkspaceCommandWorker(
  input: CreateClientInstanceWorkspaceCommandWorkerInput
): Promise<ClientInstanceWorkspaceCommandWorker> {
  const logger = createLogger();
  const env = readClientInstanceEnv(input.env);
  const config = applyWorkspaceRunnerImageEnvOverride(
    input.config ?? (await loadWorkspaceWorkerConfig(input.configPath, env)),
    env
  );
  const modules = resolveInstanceModules(config, input.capabilities).snapshot;
  if (!config.executionWorkspaces.enabled) {
    throw new AppError("VALIDATION_FAILED", "Execution workspaces are disabled in release config");
  }
  // The work of a module that this worker has a handler for. It is known before a store is
  // open, so a module that needs more of this worker stops the process here.
  const buildsPages = modules.isEnabled("apps");
  assertCommandWorkerServesModuleJobKinds(
    modules,
    buildsPages ? [pageBundleJob.kind, assetRepoCommitJob.kind, assetRepoSweepJob.kind] : []
  );
  if (buildsPages) {
    requireFilesStore(config);
  }
  endResolveOnlyRun();
  const infrastructure = await createInstanceInfrastructure({
    config,
    env,
    logger,
    secrets: input.secrets,
    // With the `apps` module on this worker also stores the Pages it builds.
    uses: [WORKSPACE_STORE_PATH, SANDBOX_PATH, ...(buildsPages ? [FILES_STORE_PATH] : [])]
  });
  const store = await createPlatformStore({
    secrets: infrastructure.secrets,
    poolSize: config.infrastructure.database.poolSize,
    logger
  });
  const clientInstanceId = getClientInstanceId(config);
  const byteStore = await createWorkspacesStore(config, infrastructure.context);
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
    reuseWorkspaceDirectories: config.executionWorkspaces.cleanup.hydratedWorkspaceIdleTtlMs > 0,
    processExecutor,
    auditRecorder,
    telemetry
  });
  const workerId = env.WORKSPACE_COMMAND_WORKER_ID;
  const commandJobs = createWorkspaceCommandJobs({
    stores: store,
    runner,
    workerId,
    slots: config.executionWorkspaces.worker.concurrency,
    tempStateCleanupIntervalMs: config.executionWorkspaces.cleanup.tempStateCleanupIntervalMs,
    hydratedWorkspaceIdleTtlMs: config.executionWorkspaces.cleanup.hydratedWorkspaceIdleTtlMs,
    auditRecorder,
    telemetry
  });
  // This process alone reaches the sandbox, so it is the one that checks it.
  const sandboxCheck = createSandboxCheckJobs({
    config,
    infrastructure,
    sandbox: processExecutor,
    stores: store
  });
  const pageBuildHandlers = await createInstancePageBuildJobs({
    config,
    modules,
    infrastructure,
    clientInstanceId,
    stores: store,
    workspaceObjects: byteStore,
    sandbox: processExecutor,
    tempRoot: env.WORKSPACE_COMMAND_TEMP_ROOT ?? tmpdir(),
    env,
    logger
  });
  const assetRepoJobs = await createInstanceAssetRepoJobs({
    config,
    modules,
    infrastructure,
    clientInstanceId,
    stores: store,
    workspaceObjects: byteStore,
    sandbox: processExecutor,
    tempRoot: env.WORKSPACE_COMMAND_TEMP_ROOT ?? tmpdir(),
    logger
  });
  const worker = createJobWorker({
    stores: store,
    clientInstanceId,
    // The worker id names this process in the log lines of its jobs.
    logger: workerId ? logger.child({ workerId }) : logger,
    handlers: [
      ...commandJobs.handlers,
      ...sandboxCheck.handlers,
      ...pageBuildHandlers,
      ...assetRepoJobs.handlers
    ],
    schedules: [...commandJobs.schedules, ...sandboxCheck.schedules, ...assetRepoJobs.schedules]
  });
  let stopped: (() => void) | undefined;
  const untilStopped = new Promise<void>((resolve) => {
    stopped = resolve;
  });

  return {
    config,
    worker,
    runUntilStopped() {
      worker.start();
      return untilStopped;
    },
    async stop() {
      try {
        await worker.stop();
      } finally {
        stopped?.();
      }
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
  input: CreateClientInstanceWorkspaceCommandWorkerInput
): Promise<void> {
  const service = await createClientInstanceWorkspaceCommandWorker(input);
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) {
      return;
    }
    stopping = true;
    createLogger().info({ signal }, "Workspace command worker is stopping");
    service.stop().catch((error: unknown) => {
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
