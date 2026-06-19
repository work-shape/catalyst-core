import type { FastifyInstance } from "fastify";
import { LocalAgentRuntime } from "@vivd-catalyst/agent-runtime";
import { StoreBackedAuditRecorder } from "@vivd-catalyst/core";
import { createChatServer } from "@vivd-catalyst/chat-server";
import type { ChatAttachmentService } from "@vivd-catalyst/chat-server";
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
  createDataSourceQueryTools,
  createDataSourceRegistry,
  createEnvSecretResolver
} from "@vivd-catalyst/data-source";
import {
  createBuiltInToolDefinitions,
  createReadSkillTool,
  InProcessToolExecution,
  SkillCatalog,
  ToolRegistry
} from "@vivd-catalyst/tool-execution";
import type { ToolAssemblyDefinition } from "@vivd-catalyst/tool-sdk";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import { assertClientAssemblyValid } from "./assembly-validation";
import { createClientInstanceAuth } from "./auth";
import type {
  ClientInstanceAttachmentHandler,
  ClientInstanceCapabilityContribution,
  ClientInstanceCapability,
  ClientInstanceManagedObjectReaderContribution
} from "./capabilities";
import type { ClientInstanceEnv } from "./env";
import { createPlatformStore, type PlatformStoreMode } from "./store";
import { createToolDefinitions } from "./tools";

export interface CreateClientInstanceAppInput {
  config?: ClientInstanceConfig;
  configPath?: string;
  env?: ClientInstanceEnv;
  storeMode?: PlatformStoreMode;
  tools: ToolAssemblyDefinition[];
  capabilities?: ClientInstanceCapability[];
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
  const store = await createPlatformStore({ env, storeMode: input.storeMode });
  const dataSources = createDataSourceRegistry({
    configs: config.dataSources,
    secretResolver: createEnvSecretResolver(env)
  });
  const capabilityContributions = await createCapabilityContributions(input.capabilities ?? [], {
    config,
    clientInstanceId,
    dataSources,
    env,
    store,
    storeMode: resolvedStoreMode
  });
  const attachments = resolveAttachmentContribution(capabilityContributions);
  const managedObjects = resolveManagedObjectContribution(capabilityContributions);
  const skillCatalog = new SkillCatalog({
    skills: config.skills
  });
  const tools = createToolDefinitions({
    config,
    tools: [
      ...createBuiltInToolDefinitions(),
      ...createDataSourceQueryTools({ dataSources }),
      createReadSkillTool({
        catalog: skillCatalog,
        getAgentSkillNames(agentName) {
          return getAgentConfig(config, agentName).skillNames;
        }
      }),
      ...capabilityContributions.flatMap((contribution) => contribution.tools ?? []),
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
    artifactReader: managedObjects
      ? {
          readArtifact(readInput) {
            return managedObjects.readArtifact(readInput);
          }
        }
      : undefined,
    fileReader: managedObjects
      ? {
          readFile(readInput) {
            return managedObjects.readFile(readInput);
          }
        }
      : undefined
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
    attachments,
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
      await closeCapabilityContributions(capabilityContributions);
      await standaloneAuth?.close();
      await store.close?.();
    }
  };
}

async function createCapabilityContributions(
  capabilities: readonly ClientInstanceCapability[],
  context: Parameters<ClientInstanceCapability["create"]>[0]
): Promise<ClientInstanceCapabilityContribution[]> {
  const contributions: ClientInstanceCapabilityContribution[] = [];
  for (const capability of capabilities) {
    contributions.push(await capability.create(context));
  }
  return contributions;
}

function resolveAttachmentContribution(
  contributions: readonly ClientInstanceCapabilityContribution[]
): ChatAttachmentService | undefined {
  const handlers = contributions.flatMap((contribution) => contribution.attachments ?? []);
  if (handlers.length === 0) {
    return undefined;
  }
  if (handlers.length === 1) {
    return handlers[0];
  }
  return createCompositeAttachmentService(handlers);
}

function resolveManagedObjectContribution(
  contributions: readonly ClientInstanceCapabilityContribution[]
) {
  const readers = contributions.flatMap((contribution) => contribution.managedObjects ?? []);
  if (readers.length === 0) {
    return undefined;
  }
  if (readers.length === 1) {
    return readers[0];
  }
  return createCompositeManagedObjectReader(readers);
}

function createCompositeAttachmentService(
  handlers: readonly ClientInstanceAttachmentHandler[]
): ChatAttachmentService {
  return {
    maxFileBytes: Math.max(...handlers.map((handler) => handler.maxFileBytes)),
    acceptedFileTypes: [...new Set(handlers.flatMap((handler) => handler.acceptedFileTypes))],
    async listDraftAttachments(conversationId) {
      return uniqueById(
        (await Promise.all(handlers.map((handler) => handler.listDraftAttachments(conversationId)))).flat()
      );
    },
    async uploadDraftAttachment(input) {
      const matchingHandlers = handlers.filter((handler) => handler.acceptsFile(input));
      if (matchingHandlers.length === 0) {
        throw new AppError("BAD_REQUEST", "No configured attachment capability accepts this file");
      }
      if (matchingHandlers.length > 1) {
        throw new AppError(
          "VALIDATION_FAILED",
          `Multiple attachment capabilities accept this file: ${matchingHandlers
            .map((handler) => handler.name)
            .join(", ")}`
        );
      }
      const handler = matchingHandlers[0];
      if (!handler) {
        throw new AppError("BAD_REQUEST", "No configured attachment capability accepts this file");
      }
      return handler.uploadDraftAttachment(input);
    },
    async retryDraftAttachment(input) {
      return tryAttachmentHandlers(handlers, (handler) => handler.retryDraftAttachment(input), input.attachmentId);
    },
    async deleteDraftAttachment(input) {
      return tryAttachmentHandlers(handlers, (handler) => handler.deleteDraftAttachment(input), input.attachmentId);
    },
    async readConversationFile(input) {
      return tryAttachmentHandlers(handlers, (handler) => handler.readConversationFile(input), input.fileId);
    },
    blockingDraftAttachmentMessage(attachments) {
      for (const handler of handlers) {
        const message = handler.blockingDraftAttachmentMessage(attachments);
        if (message) {
          return message;
        }
      }
      return undefined;
    },
    createAttachmentManifest(attachments) {
      return {
        version: 1,
        attachments: uniqueManifestEntries(
          handlers.flatMap((handler) => handler.createAttachmentManifest(attachments).attachments)
        )
      };
    },
    isInlineDisplayMimeType(mimeType) {
      return handlers.some((handler) => handler.isInlineDisplayMimeType(mimeType));
    }
  };
}

function createCompositeManagedObjectReader(
  readers: readonly ClientInstanceManagedObjectReaderContribution[]
): ClientInstanceManagedObjectReaderContribution {
  return {
    name: "composite",
    async readArtifact(input) {
      return tryManagedObjectReaders(readers, (reader) => reader.readArtifact(input), input.artifactId);
    },
    async readFile(input) {
      return tryManagedObjectReaders(readers, (reader) => reader.readFile(input), input.fileId);
    }
  };
}

async function tryAttachmentHandlers<T>(
  handlers: readonly ClientInstanceAttachmentHandler[],
  read: (handler: ClientInstanceAttachmentHandler) => Promise<T>,
  subject: string
): Promise<T> {
  for (const handler of handlers) {
    try {
      return await read(handler);
    } catch (error) {
      if (error instanceof AppError && error.code === "NOT_FOUND") {
        continue;
      }
      throw error;
    }
  }
  throw new AppError("NOT_FOUND", `Attachment object '${subject}' was not found`);
}

async function tryManagedObjectReaders<T>(
  readers: readonly ClientInstanceManagedObjectReaderContribution[],
  read: (reader: ClientInstanceManagedObjectReaderContribution) => Promise<T>,
  subject: string
): Promise<T> {
  for (const reader of readers) {
    try {
      return await read(reader);
    } catch (error) {
      if (error instanceof AppError && error.code === "NOT_FOUND") {
        continue;
      }
      throw error;
    }
  }
  throw new AppError("NOT_FOUND", `Managed object '${subject}' was not found`);
}

function uniqueById<T extends { id: string }>(records: T[]): T[] {
  return [...new Map(records.map((record) => [record.id, record])).values()];
}

function uniqueManifestEntries<T extends { kind: string; attachmentId: string }>(entries: T[]): T[] {
  return [...new Map(entries.map((entry) => [`${entry.kind}:${entry.attachmentId}`, entry])).values()];
}

async function closeCapabilityContributions(
  contributions: readonly ClientInstanceCapabilityContribution[]
): Promise<void> {
  for (const contribution of [...contributions].reverse()) {
    await contribution.close?.();
  }
}

function resolveStoreMode(explicitMode: PlatformStoreMode | undefined, env: ClientInstanceEnv): PlatformStoreMode {
  const value = explicitMode ?? env.STORE;
  if (!value) {
    return "postgres";
  }
  if (value === "memory" || value === "postgres") {
    return value;
  }
  throw new AppError("VALIDATION_FAILED", "STORE must be either 'postgres' or 'memory'");
}

async function loadConfig(configPath: string | undefined): Promise<ClientInstanceConfig> {
  if (!configPath) {
    throw new AppError("VALIDATION_FAILED", "A client instance config path is required");
  }
  return loadClientInstanceConfigFromFile(configPath);
}
