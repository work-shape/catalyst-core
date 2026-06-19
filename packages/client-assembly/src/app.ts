import type { FastifyInstance } from "fastify";
import { LocalAgentRuntime } from "@vivd-catalyst/agent-runtime";
import { StoreBackedAuditRecorder } from "@vivd-catalyst/core";
import { createChatServer } from "@vivd-catalyst/chat-server";
import { AppError } from "@vivd-catalyst/core";
import {
  type ClientInstanceConfig,
  getAgentConfig,
  getClientInstanceId,
  getEnabledToolNames,
  loadClientInstanceConfigFromFile
} from "@vivd-catalyst/config-schema";
import { createModelProviderRegistry } from "@vivd-catalyst/model-provider";
import {
  createBuiltInToolDefinitions,
  createReadSkillTool,
  InProcessToolExecution,
  SkillCatalog,
  ToolRegistry
} from "@vivd-catalyst/tool-execution";
import {
  createReadDocumentTool,
  createViewDocumentPageTool,
  DocumentAttachmentProcessor,
  DocumentPageRenderService,
  DocumentPreprocessingService,
  PlatformDocumentPreprocessor,
  RemoteDocumentPageViewer
} from "@vivd-catalyst/document-processing";
import type { ToolAssemblyDefinition } from "@vivd-catalyst/tool-sdk";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import { assertClientAssemblyValid } from "./assembly-validation";
import { createClientInstanceAuth } from "./auth";
import type { ClientInstanceEnv } from "./env";
import { createDocumentObjectStore } from "./document-object-store";
import { createPlatformStore, type PlatformStoreMode } from "./store";
import { createToolDefinitions } from "./tools";

export interface CreateClientInstanceAppInput {
  config?: ClientInstanceConfig;
  configPath?: string;
  env?: ClientInstanceEnv;
  storeMode?: PlatformStoreMode;
  tools: ToolAssemblyDefinition[];
  corsOrigin?: string | string[];
}

export interface ClientInstanceApp {
  readonly config: ClientInstanceConfig;
  readonly server: FastifyInstance;
  listen(input?: { host?: string; port?: number }): Promise<void>;
  close(): Promise<void>;
}

export async function createClientInstanceApp(
  input: CreateClientInstanceAppInput
): Promise<ClientInstanceApp> {
  const env = input.env ?? process.env;
  const config = input.config ?? (await loadConfig(input.configPath));
  const clientInstanceId = getClientInstanceId(config);
  const resolvedStoreMode = resolveStoreMode(input.storeMode, env);
  assertDocumentWorkerRuntimeConfigured({
    env,
    storeMode: resolvedStoreMode
  });
  const store = await createPlatformStore({ env, storeMode: input.storeMode });
  const objectStore = createDocumentObjectStore({
    config,
    env,
    storeMode: input.storeMode
  });
  const documentPreprocessing = new DocumentPreprocessingService({
    clientInstanceId,
    store,
    objectStore,
    config: config.documents.preprocessing
  });
  const stopInProcessDocumentProcessor =
    resolvedStoreMode === "memory" && !env.DOCUMENT_WORKER_URL
      ? startInProcessDocumentProcessor(
          new DocumentAttachmentProcessor({
            clientInstanceId,
            store,
            objectStore,
            preprocessor: new PlatformDocumentPreprocessor(config.documents.preprocessing),
            config: config.documents.preprocessing
          })
        )
      : undefined;
  const documentPageViewer = env.DOCUMENT_WORKER_URL
    ? new RemoteDocumentPageViewer({
        baseUrl: env.DOCUMENT_WORKER_URL,
        timeoutMs: config.documents.preprocessing.timeoutMs,
        token: env.DOCUMENT_WORKER_TOKEN
      })
    : new DocumentPageRenderService({
        clientInstanceId,
        store,
        objectStore,
        timeoutMs: config.documents.preprocessing.timeoutMs
      });
  const skillCatalog = new SkillCatalog({
    skills: config.skills
  });
  const tools = createToolDefinitions({
    config,
    tools: [
      ...createBuiltInToolDefinitions({
        dataSources: config.dataSources,
        env
      }),
      createReadSkillTool({
        catalog: skillCatalog,
        getAgentSkillNames(agentName) {
          return getAgentConfig(config, agentName).skillNames;
        }
      }),
      createReadDocumentTool(documentPreprocessing),
      createViewDocumentPageTool(documentPageViewer),
      ...input.tools
    ]
  });
  assertClientAssemblyValid({
    config,
    tools
  });
  const auditRecorder = new StoreBackedAuditRecorder({
    clientInstanceId,
    store
  });
  const usageGovernance = new ModelUsageGovernance({
    store,
    budget: config.usage.budget,
    safeguards: config.usage.safeguards,
    pricing: config.usage.pricing
  });
  const toolRegistry = new ToolRegistry({
    tools,
    enabledToolNames: getEnabledToolNames(config)
  });
  const toolExecution = new InProcessToolExecution({
    registry: toolRegistry,
    getAgentToolNames(agentName) {
      return getAgentConfig(config, agentName).toolNames;
    },
    auditRecorder
  });
  const modelProvider = createModelProviderRegistry({
    configs: config.modelProviders,
    env
  });
  const defaultModelProvider = config.modelProviders[0];
  if (!defaultModelProvider) {
    throw new AppError("VALIDATION_FAILED", "At least one model provider is required");
  }
  const agentRuntime = new LocalAgentRuntime({
    agents: config.agents,
    modelProviders: config.modelProviders,
    defaultModelProvider,
    conversationHistory: store,
    modelProvider,
    toolRegistry,
    toolExecution,
    usageGovernance,
    maxSteps: config.runtime.maxSteps,
    repeatedToolCallLimit: config.runtime.repeatedToolCallLimit,
    modelContext: config.modelContext,
    skills: config.skills,
    artifactReader: {
      async readArtifact(readInput) {
        const artifact = await store.getManagedArtifact(readInput);
        if (!artifact) {
          throw new AppError("NOT_FOUND", `Managed artifact '${readInput.artifactId}' was not found`);
        }
        return {
          bytes: await objectStore.getObject(artifact.objectKey),
          mimeType: artifact.mimeType
        };
      }
    },
    fileReader: {
      async readFile(readInput) {
        const file = await store.getManagedFile(readInput);
        if (!file) {
          throw new AppError("NOT_FOUND", `Managed file '${readInput.fileId}' was not found`);
        }
        return {
          bytes: await objectStore.getObject(file.objectKey),
          mimeType: file.mimeType
        };
      }
    }
  });
  const { authAdapter, standaloneAuth, sessionToken } = await createClientInstanceAuth({
    config,
    env,
    clientInstanceId,
    userStore: store,
    corsOrigin: input.corsOrigin
  });
  const server = await createChatServer({
    config,
    clientInstanceId,
    authAdapter,
    conversationStore: store,
    auditEventStore: store,
    userStore: store,
    usageGovernance,
    auditRecorder,
    agentRuntime,
    documentPreprocessing,
    modelProvider,
    corsOrigin: input.corsOrigin,
    standaloneAuth,
    sessionToken
  });

  return {
    config,
    server,
    async listen(listenInput = {}) {
      await server.listen({
        host: listenInput.host ?? env.HOST ?? "127.0.0.1",
        port: Number(listenInput.port ?? env.PORT ?? 4100)
      });
    },
    async close() {
      await server.close();
      await stopInProcessDocumentProcessor?.();
      await standaloneAuth?.close();
      await store.close?.();
    }
  };
}

function startInProcessDocumentProcessor(processor: DocumentAttachmentProcessor): () => Promise<void> {
  let running = true;
  const loop = (async () => {
    while (running) {
      const result = await processor.processNext({
        workerId: "in-process-memory-document-worker"
      });
      if (result.status === "idle") {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  })().catch((error) => {
    console.warn(
      JSON.stringify({
        type: "document_preprocessing.memory_worker_failure",
        message: error instanceof Error ? error.message : "Unknown document worker failure"
      })
    );
  });
  return async () => {
    running = false;
    await loop;
  };
}

function assertDocumentWorkerRuntimeConfigured(input: {
  env: ClientInstanceEnv;
  storeMode: PlatformStoreMode;
}): void {
  if (input.env.NODE_ENV !== "production" || input.storeMode === "memory") {
    return;
  }
  if (!nonEmptyEnv(input.env.DOCUMENT_WORKER_URL)) {
    throw new AppError(
      "VALIDATION_FAILED",
      "DOCUMENT_WORKER_URL is required in production so document page rendering does not fall back to local binaries in the API container"
    );
  }
  if (!nonEmptyEnv(input.env.DOCUMENT_WORKER_TOKEN)) {
    throw new AppError(
      "VALIDATION_FAILED",
      "DOCUMENT_WORKER_TOKEN is required in production when DOCUMENT_WORKER_URL is configured"
    );
  }
}

function resolveStoreMode(
  explicitMode: PlatformStoreMode | undefined,
  env: ClientInstanceEnv
): PlatformStoreMode {
  const value = explicitMode ?? env.STORE;
  if (!value) {
    return "postgres";
  }
  if (value === "memory" || value === "postgres") {
    return value;
  }
  throw new AppError("VALIDATION_FAILED", "STORE must be either 'postgres' or 'memory'");
}

function nonEmptyEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function loadConfig(configPath: string | undefined): Promise<ClientInstanceConfig> {
  if (!configPath) {
    throw new AppError("VALIDATION_FAILED", "A client instance config path is required");
  }
  return loadClientInstanceConfigFromFile(configPath);
}
