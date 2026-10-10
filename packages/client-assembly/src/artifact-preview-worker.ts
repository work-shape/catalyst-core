import { createLogger } from "./logger";
import {
  AppError,
  type JobWorker,
  type PlatformStores,
  type ProviderCreateContext,
  type SecretResolver
} from "@vivd-catalyst/core";
import {
  getClientInstanceId,
  loadClientInstanceConfigFromFile,
  type ClientInstanceConfig
} from "@vivd-catalyst/config-schema";
import {
  createArtifactPreviewJobHandler,
  LibreOfficeArtifactPreviewRenderer
} from "@vivd-catalyst/tool-execution";
import type { ArtifactPreviewSourceReader } from "@vivd-catalyst/tool-execution";
import { readClientInstanceEnv, type ClientInstanceEnv } from "./env";
import {
  createInstanceInfrastructure,
  createWorkspaceObjectStore,
  WORKSPACE_STORE_PATH
} from "./infrastructure";
import { createJobWorker } from "./job-worker";
import { createPlatformStore } from "./store";

export interface CreateClientInstanceArtifactPreviewWorkerInput {
  config?: ClientInstanceConfig;
  configPath?: string;
  env?: ClientInstanceEnv;
  /** Replaces the configured secret provider. For tests. */
  secrets?: SecretResolver;
  sourceReaderFactory?: ArtifactPreviewSourceReaderFactory;
}

export type ArtifactPreviewSourceReaderFactory = (input: {
  config: ClientInstanceConfig;
  clientInstanceId: ReturnType<typeof getClientInstanceId>;
  env: ClientInstanceEnv;
  /** What a reader creates its own provider with, such as a capability's object store. */
  context: ProviderCreateContext;
  store: PlatformStores;
}) => ArtifactPreviewSourceReader | Promise<ArtifactPreviewSourceReader>;

export interface ClientInstanceArtifactPreviewWorker {
  readonly config: ClientInstanceConfig;
  /** The job worker that serves `artifact_preview.render`. */
  readonly worker: JobWorker;
  /** Starts the worker and resolves once `stop` has given its jobs back. */
  runUntilStopped(): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
}

export async function createClientInstanceArtifactPreviewWorker(
  input: CreateClientInstanceArtifactPreviewWorkerInput = {}
): Promise<ClientInstanceArtifactPreviewWorker> {
  const logger = createLogger();
  const env = readClientInstanceEnv(input.env);
  const config = input.config ?? (await loadArtifactPreviewWorkerConfig(input.configPath, env));
  const infrastructure = await createInstanceInfrastructure({
    config,
    env,
    logger,
    secrets: input.secrets,
    uses: [WORKSPACE_STORE_PATH]
  });
  const { secrets } = infrastructure;
  const store = await createPlatformStore({
    secrets,
    poolSize: config.infrastructure.database.poolSize,
    logger
  });
  const clientInstanceId = getClientInstanceId(config);
  const sourceReader = input.sourceReaderFactory
    ? await input.sourceReaderFactory({
        config,
        clientInstanceId,
        env,
        context: infrastructure.context,
        store
      })
    : undefined;
  const objectStore = (await createWorkspaceObjectStore(config, infrastructure.context)).objects;
  const worker = createJobWorker({
    stores: store,
    clientInstanceId,
    // The worker id names this process in the log lines of its jobs.
    logger: env.ARTIFACT_PREVIEW_WORKER_ID
      ? logger.child({ workerId: env.ARTIFACT_PREVIEW_WORKER_ID })
      : logger,
    handlers: [
      createArtifactPreviewJobHandler({
        stores: store,
        objectStore,
        sourceReader,
        renderer: new LibreOfficeArtifactPreviewRenderer({
          sofficeCommand: env.ARTIFACT_PREVIEW_SOFFICE_COMMAND,
          pdfInfoCommand: env.ARTIFACT_PREVIEW_PDFINFO_COMMAND,
          pdfToPpmCommand: env.ARTIFACT_PREVIEW_PDFTOPPM_COMMAND,
          tempRootDirectory: env.ARTIFACT_PREVIEW_TEMP_ROOT
        }),
        slots: readPositiveIntegerEnv(env, "ARTIFACT_PREVIEW_CONCURRENCY"),
        maxPages: readPositiveIntegerEnv(env, "ARTIFACT_PREVIEW_MAX_PAGES"),
        maxSourceBytes: readPositiveIntegerEnv(env, "ARTIFACT_PREVIEW_MAX_SOURCE_BYTES"),
        maxConvertedPdfBytes: readPositiveIntegerEnv(
          env,
          "ARTIFACT_PREVIEW_MAX_CONVERTED_PDF_BYTES"
        ),
        maxOutputBytes: readPositiveIntegerEnv(env, "ARTIFACT_PREVIEW_MAX_OUTPUT_BYTES"),
        maxRasterDimension: readPositiveIntegerEnv(env, "ARTIFACT_PREVIEW_MAX_RASTER_DIMENSION"),
        conversionTimeoutMs: readPositiveIntegerEnv(env, "ARTIFACT_PREVIEW_CONVERSION_TIMEOUT_MS"),
        rasterizationTimeoutMs: readPositiveIntegerEnv(
          env,
          "ARTIFACT_PREVIEW_RASTERIZATION_TIMEOUT_MS"
        ),
        previewDpi: readPositiveIntegerEnv(env, "ARTIFACT_PREVIEW_DPI")
      })
    ]
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
      // Gives back the jobs it still holds while the database is open.
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
    createLogger().info({ signal }, "Artifact preview worker is stopping");
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

function readPositiveIntegerEnv(env: ClientInstanceEnv, name: string): number | undefined {
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
