import { AppError } from "@vivd-catalyst/core";
import {
  getClientInstanceId,
  loadClientInstanceConfigFromFile,
  type ClientInstanceConfig
} from "@vivd-catalyst/config-schema";
import {
  ArtifactPreviewWorker,
  createLocalWorkspaceObjectStorage,
  LibreOfficeArtifactPreviewRenderer
} from "@vivd-catalyst/tool-execution";
import type { ClientInstanceEnv } from "./env";
import { createPlatformStore, type PlatformStoreMode } from "./store";

export interface CreateClientInstanceArtifactPreviewWorkerInput {
  config?: ClientInstanceConfig;
  configPath?: string;
  env?: ClientInstanceEnv;
  storeMode?: PlatformStoreMode;
}

export interface ClientInstanceArtifactPreviewWorker {
  readonly config: ClientInstanceConfig;
  readonly worker: ArtifactPreviewWorker;
  runUntilStopped(): Promise<void>;
  stop(input?: { cancelActive?: boolean; reason?: string }): Promise<void>;
  close(): Promise<void>;
}

export async function createClientInstanceArtifactPreviewWorker(
  input: CreateClientInstanceArtifactPreviewWorkerInput = {}
): Promise<ClientInstanceArtifactPreviewWorker> {
  const env = input.env ?? process.env;
  const config = input.config ?? (await loadArtifactPreviewWorkerConfig(input.configPath, env));
  const store = await createPlatformStore({ env, storeMode: input.storeMode });
  const objectStore = createLocalWorkspaceObjectStorage({
    rootDirectory: objectRoot(env)
  });
  const worker = new ArtifactPreviewWorker({
    clientInstanceId: getClientInstanceId(config),
    store,
    objectStore,
    renderer: new LibreOfficeArtifactPreviewRenderer({
      sofficeCommand: env.ARTIFACT_PREVIEW_SOFFICE_COMMAND,
      pdfInfoCommand: env.ARTIFACT_PREVIEW_PDFINFO_COMMAND,
      pdfToPpmCommand: env.ARTIFACT_PREVIEW_PDFTOPPM_COMMAND,
      tempRootDirectory: env.ARTIFACT_PREVIEW_TEMP_ROOT
    }),
    workerId: env.ARTIFACT_PREVIEW_WORKER_ID,
    concurrency: readPositiveIntegerEnv(env, "ARTIFACT_PREVIEW_CONCURRENCY"),
    pollIntervalMs: readPositiveIntegerEnv(env, "ARTIFACT_PREVIEW_POLL_INTERVAL_MS"),
    leaseDurationMs: readPositiveIntegerEnv(env, "ARTIFACT_PREVIEW_LEASE_DURATION_MS"),
    maxAttempts: readPositiveIntegerEnv(env, "ARTIFACT_PREVIEW_MAX_ATTEMPTS"),
    maxPages: readPositiveIntegerEnv(env, "ARTIFACT_PREVIEW_MAX_PAGES"),
    maxSourceBytes: readPositiveIntegerEnv(env, "ARTIFACT_PREVIEW_MAX_SOURCE_BYTES"),
    conversionTimeoutMs: readPositiveIntegerEnv(env, "ARTIFACT_PREVIEW_CONVERSION_TIMEOUT_MS"),
    rasterizationTimeoutMs: readPositiveIntegerEnv(
      env,
      "ARTIFACT_PREVIEW_RASTERIZATION_TIMEOUT_MS"
    ),
    previewDpi: readPositiveIntegerEnv(env, "ARTIFACT_PREVIEW_DPI")
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

export async function runClientInstanceArtifactPreviewWorker(
  input: CreateClientInstanceArtifactPreviewWorkerInput = {}
): Promise<void> {
  const service = await createClientInstanceArtifactPreviewWorker(input);
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

async function loadArtifactPreviewWorkerConfig(
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

function objectRoot(env: ClientInstanceEnv): string {
  const value = env.ARTIFACT_PREVIEW_OBJECT_ROOT ?? env.EXECUTION_WORKSPACE_OBJECT_ROOT;
  if (!value) {
    throw new AppError(
      "VALIDATION_FAILED",
      "ARTIFACT_PREVIEW_OBJECT_ROOT or EXECUTION_WORKSPACE_OBJECT_ROOT is required for artifact preview workers"
    );
  }
  return value;
}

function readPositiveIntegerEnv(
  env: ClientInstanceEnv,
  name: string
): number | undefined {
  const raw = env[name];
  if (!raw) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new AppError("VALIDATION_FAILED", `${name} must be a positive integer`);
  }
  return value;
}
