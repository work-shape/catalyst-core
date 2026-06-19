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
import type { ToolAssemblyDefinition } from "@vivd-catalyst/tool-sdk";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import { assertClientAssemblyValid } from "./assembly-validation";
import { createClientInstanceAuth } from "./auth";
import type {
  ClientInstanceCapabilityContribution,
  ClientInstanceCapability
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
  const capabilityContributions = await createCapabilityContributions(input.capabilities ?? [], {
    config,
    clientInstanceId,
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

function resolveAttachmentContribution(contributions: readonly ClientInstanceCapabilityContribution[]) {
  const attachmentContributions = contributions
    .map((contribution) => contribution.attachments)
    .filter((attachments) => attachments !== undefined);
  if (attachmentContributions.length > 1) {
    throw new AppError("VALIDATION_FAILED", "Only one attachment handling capability can be configured");
  }
  return attachmentContributions[0];
}

function resolveManagedObjectContribution(
  contributions: readonly ClientInstanceCapabilityContribution[]
) {
  const managedObjectContributions = contributions
    .map((contribution) => contribution.managedObjects)
    .filter((reader) => reader !== undefined);
  if (managedObjectContributions.length > 1) {
    throw new AppError("VALIDATION_FAILED", "Only one managed object reader capability can be configured");
  }
  return managedObjectContributions[0];
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
