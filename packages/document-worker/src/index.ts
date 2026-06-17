import Fastify, { type FastifyInstance } from "fastify";
import {
  AppError,
  asConversationId,
  isAppError,
  type ClientInstanceId
} from "@vivd-catalyst/core";
import {
  getClientInstanceId,
  loadClientInstanceConfigFromFile,
  type ClientInstanceConfig
} from "@vivd-catalyst/config-schema";
import {
  createDocumentObjectStore,
  createPlatformStore,
  type ClientInstanceEnv,
  type PlatformStoreMode
} from "@vivd-catalyst/client-assembly";
import {
  DocumentAttachmentProcessor,
  DocumentPageRenderService,
  PlatformDocumentPreprocessor,
  type ViewDocumentPageInput
} from "@vivd-catalyst/document-processing";

export interface CreateDocumentWorkerInput {
  config?: ClientInstanceConfig;
  configPath?: string;
  env?: ClientInstanceEnv;
  storeMode?: PlatformStoreMode;
  workerId?: string;
  pollIntervalMs?: number;
  concurrency?: number;
}

export interface DocumentWorkerApp {
  readonly config: ClientInstanceConfig;
  readonly clientInstanceId: ClientInstanceId;
  readonly server: FastifyInstance;
  listen(input?: { host?: string; port?: number }): Promise<void>;
  close(): Promise<void>;
}

export async function createDocumentWorker(
  input: CreateDocumentWorkerInput
): Promise<DocumentWorkerApp> {
  const env = input.env ?? process.env;
  const config = input.config ?? (await loadConfig(input.configPath));
  const clientInstanceId = getClientInstanceId(config);
  const workerId = input.workerId ?? env.DOCUMENT_WORKER_ID ?? createWorkerId();
  const pollIntervalMs = input.pollIntervalMs ?? numberFromEnv(env.DOCUMENT_WORKER_POLL_INTERVAL_MS, 1000);
  const concurrency = input.concurrency ?? numberFromEnv(env.DOCUMENT_WORKER_CONCURRENCY, config.documents.preprocessing.globalConcurrency);
  const store = await createPlatformStore({
    env: {
      ...env,
      RUN_MIGRATIONS: "false"
    },
    storeMode: input.storeMode
  });
  const objectStore = createDocumentObjectStore({
    config,
    env,
    storeMode: input.storeMode
  });
  const processor = new DocumentAttachmentProcessor({
    clientInstanceId,
    store,
    objectStore,
    preprocessor: new PlatformDocumentPreprocessor(config.documents.preprocessing),
    config: config.documents.preprocessing
  });
  const pageRenderer = new DocumentPageRenderService({
    clientInstanceId,
    store,
    objectStore,
    timeoutMs: config.documents.preprocessing.timeoutMs
  });
  const server = Fastify({
    logger: true
  });
  installErrorHandler(server);
  server.get("/health", async () => ({
    status: "ok",
    clientInstanceId,
    workerId,
    time: new Date().toISOString()
  }));
  server.post("/internal/document-pages/render", async (request) => {
    requireWorkerToken(request.headers.authorization, env.DOCUMENT_WORKER_TOKEN);
    return pageRenderer.viewPage(parseViewDocumentPageInput(request.body));
  });

  let running = false;
  const loops: Promise<void>[] = [];

  function startProcessing(): void {
    if (running) {
      return;
    }
    running = true;
    for (let index = 0; index < concurrency; index += 1) {
      loops.push(runProcessingLoop(`${workerId}-${index + 1}`));
    }
  }

  async function runProcessingLoop(slotWorkerId: string): Promise<void> {
    while (running) {
      try {
        const result = await processor.processNext({
          workerId: slotWorkerId
        });
        if (result.status === "idle") {
          await delay(pollIntervalMs);
        }
      } catch (error) {
        server.log.error(
          {
            err: error,
            workerId: slotWorkerId
          },
          "document worker processing failed"
        );
        await delay(pollIntervalMs);
      }
    }
  }

  return {
    config,
    clientInstanceId,
    server,
    async listen(listenInput = {}) {
      await server.listen({
        host: listenInput.host ?? env.HOST ?? "127.0.0.1",
        port: Number(listenInput.port ?? env.PORT ?? 4110)
      });
      startProcessing();
    },
    async close() {
      running = false;
      await Promise.allSettled(loops);
      await server.close();
      await store.close?.();
    }
  };
}

async function loadConfig(configPath: string | undefined): Promise<ClientInstanceConfig> {
  if (!configPath) {
    throw new AppError("VALIDATION_FAILED", "A client instance config path is required");
  }
  return loadClientInstanceConfigFromFile(configPath);
}

function installErrorHandler(server: FastifyInstance): void {
  server.setErrorHandler((error, _request, reply) => {
    if (isAppError(error)) {
      void reply.status(error.statusCode).send({
        code: error.code,
        message: error.message
      });
      return;
    }
    void reply.status(500).send({
      code: "INTERNAL",
      message: error instanceof Error ? error.message : "Document worker request failed"
    });
  });
}

function parseViewDocumentPageInput(body: unknown): ViewDocumentPageInput {
  if (!body || typeof body !== "object") {
    throw new AppError("BAD_REQUEST", "Request body is required");
  }
  const value = body as {
    conversationId?: unknown;
    fileId?: unknown;
    pageNumber?: unknown;
    dpi?: unknown;
  };
  if (typeof value.conversationId !== "string" || value.conversationId.length === 0) {
    throw new AppError("BAD_REQUEST", "conversationId is required");
  }
  if (typeof value.fileId !== "string" || value.fileId.length === 0) {
    throw new AppError("BAD_REQUEST", "fileId is required");
  }
  if (typeof value.pageNumber !== "number" || !Number.isFinite(value.pageNumber)) {
    throw new AppError("BAD_REQUEST", "pageNumber is required");
  }
  if (value.dpi !== undefined && (typeof value.dpi !== "number" || !Number.isFinite(value.dpi))) {
    throw new AppError("BAD_REQUEST", "dpi must be a number");
  }
  return {
    conversationId: asConversationId(value.conversationId),
    fileId: value.fileId,
    pageNumber: value.pageNumber,
    dpi: value.dpi
  };
}

function requireWorkerToken(header: string | undefined, configuredToken: string | undefined): void {
  if (!configuredToken) {
    return;
  }
  if (header !== `Bearer ${configuredToken}`) {
    throw new AppError("UNAUTHENTICATED", "Document worker token is invalid");
  }
}

function createWorkerId(): string {
  return `doc-worker-${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`;
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
