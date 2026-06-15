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
  InProcessToolExecution,
  ToolRegistry
} from "@vivd-catalyst/tool-execution";
import {
  createReadDocumentTool,
  DocumentPreprocessingService,
  InMemoryObjectStore,
  MarkItDownDocumentTextConverter,
  S3ObjectStore
} from "@vivd-catalyst/document-processing";
import type { ToolAssemblyDefinition } from "@vivd-catalyst/tool-sdk";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import { assertClientAssemblyValid } from "./assembly-validation";
import { createClientInstanceAuth } from "./auth";
import type { ClientInstanceEnv } from "./env";
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
  const store = await createPlatformStore({ env, storeMode: input.storeMode });
  const objectStore =
    (input.storeMode ?? env.STORE) === "memory"
      ? new InMemoryObjectStore()
      : new S3ObjectStore({
          config: {
            ...config.documents.objectStorage,
            bucket: env.DOCUMENT_OBJECT_STORE_BUCKET ?? config.documents.objectStorage.bucket,
            region: env.DOCUMENT_OBJECT_STORE_REGION ?? config.documents.objectStorage.region,
            endpoint: env.DOCUMENT_OBJECT_STORE_ENDPOINT ?? config.documents.objectStorage.endpoint
          },
          env
        });
  const documentPreprocessing = new DocumentPreprocessingService({
    clientInstanceId,
    store,
    objectStore,
    converter: new MarkItDownDocumentTextConverter(config.documents.preprocessing),
    config: config.documents.preprocessing
  });
  const tools = createToolDefinitions({
    config,
    tools: [
      ...createBuiltInToolDefinitions({
        dataSources: config.dataSources,
        env
      }),
      createReadDocumentTool(documentPreprocessing),
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
    modelContext: config.modelContext
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
      await standaloneAuth?.close();
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
