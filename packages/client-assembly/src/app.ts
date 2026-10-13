import { createLogger } from "./logger";
import {
  StoreBackedAgentRuntime,
  createAgentRunSignal,
  type WorkerLocalAgentRuntimeOptions
} from "@vivd-catalyst/agent-runtime";
import {
  REASONING_EFFORTS,
  StoreBackedAuditRecorder,
  type AgentConfig,
  type ApprovalRequestHandlerRegistry,
  type StructuredDataPublicationReviewer
} from "@vivd-catalyst/core";
import {
  createSkillChangeApprovalHandler,
  createChatServer,
  createChatServerJobs
} from "@vivd-catalyst/chat-server";
import type {
  ChatAttachmentService,
  ChatServerOptions,
  ConfigAssetValidationRefs
} from "@vivd-catalyst/chat-server";
import { createManagedObjectAccess } from "@vivd-catalyst/capability-sdk";
import {
  AppError,
  type ConnectorTypeDefinition,
  type HttpRuntime,
  type JobWorker,
  type PlatformStores,
  type SecretResolver
} from "@vivd-catalyst/core";
import {
  type ClientInstanceConfig,
  getClientInstanceId,
  getEnabledToolNames,
  getModelProviderConfigs,
  loadClientInstanceConfigFromFile,
  validateConfigAssetBundle
} from "@vivd-catalyst/config-schema";
import { createDataSourceTools, createDataSourceRegistry } from "@vivd-catalyst/data-source";
import { createWebFetchToolDefinitions } from "@vivd-catalyst/web-access";
import {
  createBuiltInToolDefinitions,
  createConsoleWorkspaceCommandTelemetry,
  createReadSkillTool,
  createProposeSkillChangeTool,
  createStructuredDataToolDefinitions,
  createWorkspaceToolDefinitions,
  WorkspaceCommandService
} from "@vivd-catalyst/tool-execution";
import type { ToolAssemblyDefinition } from "@vivd-catalyst/tool-sdk";
import {
  assertCapabilityConfigKeys,
  assertClientAssemblyValid,
  findConfigAssetAgentValidationIssues,
  findModuleOffToolIssues
} from "./assembly-validation";
import { createInstanceModels } from "./capability-models";
import { createConfigAssetSource } from "./config-asset-source";
import { createInstanceAgentTools, createInstanceOperationCalls } from "./operation-calls";
import { createClientInstanceAuth } from "./auth";
import { createInstanceConnections, withConnections } from "./connections";
import { createInstanceAssetKinds } from "./instance-asset-kinds";
import { seedInstance } from "./instance-seed";
import { createClientInstanceMail } from "./mail";
import type {
  ClientInstanceAttachmentHandler,
  ClientInstanceCapabilityContribution,
  ClientInstanceCapability,
  ClientInstanceManagedObjectReaderContribution
} from "./capabilities";
import { readClientInstanceEnv, type ClientInstanceEnv } from "./env";
import { createInstanceInfrastructure, createWorkspacesStore } from "./infrastructure";
import { createInfrastructureWorkflow } from "./infrastructure";
import { createInProcessAgentRunWorker, type AgentRunWorkerPlacement } from "./agent-run-jobs";
import { createInstancePageSave, createInstancePages } from "./pages";
import { createJobWorker } from "./job-worker";
import { createPlatformTools } from "./conversation-offer";
import { assembleModules, endResolveOnlyRun, resolveInstanceModules } from "./modules";
import { createRuntimeFailureReporter } from "./runtime-error-logging";
import { createPlatformStore } from "./store";
import { createToolDefinitions } from "./tools";
import {
  createExecutionWorkspaceManagedObjectReader,
  createExecutionWorkspaceSourceAttachmentHandler
} from "./workspace-source-attachments";

export interface CreateClientInstanceAppInput {
  config?: ClientInstanceConfig;
  configPath?: string;
  env?: ClientInstanceEnv;
  /** Replaces the configured secret provider. For tests. */
  secrets?: SecretResolver;
  tools: ToolAssemblyDefinition[];
  /** The Connector types of this build. A Connection of another type stops startup. */
  connectorTypes?: ConnectorTypeDefinition[];
  /** The capabilities of this build, the same ones every process of the instance is given. */
  capabilities: readonly ClientInstanceCapability[];
  structuredDataPublicationReviewer?: StructuredDataPublicationReviewer;
  approvalRequestHandlers?: ApprovalRequestHandlerRegistry;
  /** What the calls of operations run with beyond the instance's own defaults. For tests. */
  operations?: ChatServerOptions["operations"];
  allowedOrigins?: string | string[];
  agentRunWorker?: AgentRunWorkerPlacement;
}

/** Listens on `HOST` and `PORT` of the instance's environment unless told otherwise. */
export interface ClientInstanceApp extends HttpRuntime {
  readonly config: ClientInstanceConfig;
  readonly store: PlatformStores;
  /** Serves the API process's job kinds. `listen` starts it and `close` stops it. */
  readonly jobs: JobWorker;
  /**
   * Serves `agent_run.execute` when the runs execute in this process. `listen` starts it and
   * `close` stops it. Missing when the instance has worker processes of its own for them.
   */
  readonly agentRunJobs?: JobWorker;
}

export async function createClientInstanceApp(
  input: CreateClientInstanceAppInput
): Promise<ClientInstanceApp> {
  const execution = await createClientInstanceExecutionAssembly(input);
  const {
    logger,
    env,
    config,
    clientInstanceId,
    store,
    attachments,
    managedObjects,
    jobRetries,
    workspaceObjectStore,
    pages,
    auditRecorder,
    usageGovernance,
    modelGateway
  } = execution;
  // Only the API process seeds, before it takes a request. A worker reads what is stored.
  await seedInstance(execution);
  // A run is a row and a job. The API reads its events from the store; a worker executes it.
  // Where that worker is in this process, the two tell each other and need not poll.
  const inProcess =
    (input.agentRunWorker ?? "in_process") === "in_process"
      ? { observations: createAgentRunSignal(), cancellations: createAgentRunSignal() }
      : undefined;
  const agentRuntime = new StoreBackedAgentRuntime({ store: store.agentRuns, ...inProcess });
  const { authAdapter, standaloneAuth, sessionToken, serviceAccessToken, allowedOrigins } =
    await createClientInstanceAuth({
      config,
      env,
      secrets: execution.infrastructure.secrets,
      clientInstanceId,
      userStore: store,
      allowedOrigins: input.allowedOrigins
    });
  const serverOptions: ChatServerOptions = {
    logger,
    config,
    modules: execution.modules,
    infrastructure: createInfrastructureWorkflow(config, execution.infrastructure, store),
    clientInstanceId,
    authAdapter,
    stores: store,
    usageGovernance,
    auditRecorder,
    authorizer: execution.authorizer,
    // The routes register their operations where the agents of this process have their tools.
    operationCalls: execution.operationCalls,
    operations: input.operations,
    approvalRequests: {
      store: store.approvals,
      handlers: execution.approvalRequestHandlers,
      onDecided: (request) => store.approvals.appendApprovalDecision(request)
    },
    configAssets: execution.configAssets,
    agentRuntime,
    connections: execution.connections?.management,
    attachments,
    managedObjects,
    jobRetries,
    pages,
    executionWorkspaceCleanup: workspaceObjectStore
      ? {
          store: store.executionWorkspaces,
          // Deletion erases by the exact keys its rows name, never by a prefix.
          objects: { deleteObject: (key) => workspaceObjectStore.delete(key) },
          jobOptions: {
            checkIntervalMs: config.executionWorkspaces.cleanup.deletedWorkspaceCleanupIntervalMs,
            batchSize: config.executionWorkspaces.cleanup.deletedWorkspaceCleanupBatchSize
          }
        }
      : undefined,
    modelGateway,
    allowedOrigins,
    standaloneAuth,
    mail: await createClientInstanceMail({
      config,
      registry: execution.infrastructure.registry,
      context: execution.infrastructure.context
    }),
    sessionToken,
    serviceAccessToken
  };
  const server = await createChatServer(serverOptions, { routes: execution.modulesStarted.routes });
  const serverJobs = createChatServerJobs(serverOptions);
  const jobs = createJobWorker({
    stores: store,
    clientInstanceId,
    logger,
    modules: execution.modules,
    handlers: [...serverJobs.handlers, ...execution.modulesStarted.jobHandlers],
    schedules: [...serverJobs.schedules, ...execution.modulesStarted.schedules]
  });
  const agentRunJobs = inProcess ? createInProcessAgentRunWorker(execution, inProcess) : undefined;

  return {
    config,
    store,
    jobs,
    agentRunJobs,
    // The server's own function, unwrapped.
    fetch: server.fetch,
    async listen(listenInput = {}) {
      const baseUrl = await server.listen({
        host: listenInput.host ?? env.HOST ?? "127.0.0.1",
        port: Number(listenInput.port ?? env.PORT ?? 4100)
      });
      jobs.start();
      agentRunJobs?.start();
      return baseUrl;
    },
    async close() {
      // The workers go first: they give their jobs back while the database is still open. A
      // run that is executing here is ended as interrupted.
      await Promise.all([jobs.stop(), agentRunJobs?.stop()]);
      await server.close();
      await standaloneAuth?.close();
      await execution.close();
    }
  };
}

export async function createClientInstanceExecutionAssembly(
  input: Omit<CreateClientInstanceAppInput, "agentRunWorker" | "allowedOrigins">
) {
  const logger = createLogger();
  const env = readClientInstanceEnv(input.env);
  const config = input.config ?? (await loadConfig(input.configPath));
  const clientInstanceId = getClientInstanceId(config);
  const { capabilities } = input;
  const modules = resolveInstanceModules(config, capabilities).snapshot;
  assertCapabilityConfigKeys(capabilities, config.capabilities);
  endResolveOnlyRun();
  // The resolver comes first: the store, the sign-in code and every provider take from it.
  const infrastructure = await createInstanceInfrastructure({
    config,
    env,
    logger,
    secrets: input.secrets,
    providers: capabilities.flatMap((capability) => capability.providers ?? [])
  });
  const { secrets } = infrastructure;
  const store = await createPlatformStore({
    secrets,
    poolSize: config.infrastructure.database.poolSize,
    logger
  });
  const connectionParts = { config, modules, clientInstanceId, secrets, stores: store, logger };
  const connections = await createInstanceConnections(connectionParts, input.connectorTypes);
  const moduleAssembly = await assembleModules(connectionParts);
  const dataSources = await createDataSourceRegistry({ configs: config.dataSources, secrets });
  const workspaceObjectStore = config.executionWorkspaces.enabled
    ? await createWorkspacesStore(config, infrastructure.context)
    : undefined;
  const pages = await createInstancePages({ config, modules, infrastructure });
  const modelProviders = getModelProviderConfigs(config);
  // Before the capabilities: one of them may call a model, and asks at startup what the model
  // of its binding can do.
  const models = await createInstanceModels({ config, clientInstanceId, infrastructure, store });
  const { governance: usageGovernance, gateway: modelGateway } = models;
  const capabilityContributions = await createCapabilityContributions(capabilities, {
    logger,
    capabilitiesConfig: config.capabilities,
    modules,
    clientInstanceId,
    dataSources,
    env,
    secrets,
    objectStorage: config.infrastructure.objectStorage,
    files: store.files,
    jobs: store.jobs,
    transaction: (fn) => store.transaction((tx) => fn({ files: tx.files, jobs: tx.jobs })),
    models: models.capabilityModels,
    managedObjectAccess: {
      createAccess(accessInput) {
        return createManagedObjectAccess({
          clientInstanceId,
          files: store.files,
          logger,
          ...accessInput
        });
      }
    }
  });
  const capabilityAttachmentHandlers = capabilityContributions.flatMap(
    (contribution) => contribution.attachments ?? []
  );
  const workspaceSourceAttachment = workspaceObjectStore
    ? createExecutionWorkspaceSourceAttachmentHandler({
        clientInstanceId,
        files: store.files,
        objectStore: workspaceObjectStore,
        maxFileBytes: config.executionWorkspaces.sourceFiles.maxFileBytes,
        markDeletedOnDelete: capabilityAttachmentHandlers.length === 0
      })
    : undefined;
  const attachments = resolveAttachmentHandlers([
    ...(workspaceSourceAttachment ? [workspaceSourceAttachment] : []),
    ...capabilityAttachmentHandlers
  ]);
  const workspaceManagedObjectReader = workspaceObjectStore
    ? createExecutionWorkspaceManagedObjectReader({
        clientInstanceId,
        files: store.files,
        byteStore: workspaceObjectStore
      })
    : undefined;
  const auditRecorder = new StoreBackedAuditRecorder({ clientInstanceId, store: store.audit });
  const managedObjects = resolveManagedObjectReaders([
    ...(workspaceManagedObjectReader ? [workspaceManagedObjectReader] : []),
    ...capabilityContributions.flatMap((contribution) => contribution.managedObjects ?? [])
  ]);
  const jobRetries = capabilityContributions.flatMap(
    (contribution) => contribution.jobRetries ?? []
  );
  const assetSource = createConfigAssetSource({ store: store.configAssets, clientInstanceId });
  const validationRefs: ConfigAssetValidationRefs = {
    modelProviderIds: modelProviders.map((provider) => provider.id),
    modelBindingIds: config.modelBindings
      .filter((binding) => binding.agentSelectable !== false)
      .map((binding) => binding.id),
    modelBindings: config.modelBindings
      .filter((binding) => binding.agentSelectable !== false)
      .map((binding) => {
        const model =
          binding.model ??
          modelProviders.find((provider) => provider.id === binding.providerId)?.model;
        if (model === undefined) throw new Error(`Model binding ${binding.id} has no model`);
        return { id: binding.id, model, ...(binding.label ? { label: binding.label } : {}) };
      }),
    fastModeModelBindingIds: fastModeModelBindingIds(config),
    reasoningEfforts: [...REASONING_EFFORTS],
    enabledToolNames: [...getEnabledToolNames(config)]
  };
  // A write is refused for an agent it adds or changes that names a tool of a module that is
  // off. A stored agent that still names one starts and runs without it, and does not stand in
  // the way of a write to another agent or a skill.
  const validateAgents = (agents: AgentConfig[], changed: AgentConfig[]) => [
    ...findModuleOffToolIssues(modules, changed),
    ...findConfigAssetAgentValidationIssues(config, agents, (binding) =>
      modelGateway.capabilities(binding)
    )
  ];
  const configAssets: Parameters<typeof createChatServer>[0]["configAssets"] = {
    store: store.configAssets,
    source: assetSource,
    kinds: createInstanceAssetKinds({
      agent: { config, validationRefs, validateAgents },
      skill: { config },
      connections,
      modules,
      moduleKinds: moduleAssembly.assetKinds
    }),
    validationRefs
  };
  const approvalRequestHandlers = new Map(input.approvalRequestHandlers ?? []);
  const skillPolicy = config.administration.agentConfiguration.agentSkillChanges;
  if (skillPolicy.enabled) {
    if (approvalRequestHandlers.has("skill_change")) {
      throw new AppError("VALIDATION_FAILED", "The skill_change approval kind is platform-owned");
    }
    const handler = createSkillChangeApprovalHandler({ config, clientInstanceId, configAssets });
    approvalRequestHandlers.set(handler.kind, handler);
  }
  const platformTools = createPlatformTools({ stores: store, modules });
  const { conversationOffer } = platformTools;
  const { authorizer, operationCalls, approvalRequestCreator } = createInstanceOperationCalls({
    clientInstanceId,
    conversationOffer,
    config,
    logger,
    modules,
    store,
    auditRecorder,
    modelGateway,
    assetSource,
    configAssets,
    approvalRequestHandlers,
    operations: input.operations
  });
  const handlers = operationCalls.approvalRequestHandlers;
  // The agent's asset tools are carried out by the asset operations, in this process too.
  const assetOptions = { logger, config, modules, clientInstanceId, stores: store, pages };
  platformTools.bind({ ...assetOptions, auditRecorder, configAssets, authorizer, operationCalls });
  const workspaceService = config.executionWorkspaces.enabled
    ? new WorkspaceCommandService({
        store,
        objectStore: workspaceObjectStore,
        fileStore: workspaceObjectStore,
        auditRecorder,
        telemetry: createConsoleWorkspaceCommandTelemetry(logger),
        limits: config.executionWorkspaces.command,
        sourceFileReader: attachments
          ? {
              readSourceFile(readInput) {
                return attachments.readConversationFile({
                  conversationId: readInput.conversationId,
                  fileId: readInput.fileId
                });
              }
            }
          : undefined
      })
    : undefined;
  const pageSave = createInstancePageSave({ modules, stores: store, workspaceService });
  const tools = createToolDefinitions({
    config,
    tools: [
      ...createBuiltInToolDefinitions(config.views, { apps: pageSave }),
      ...(workspaceService ? createWorkspaceToolDefinitions({ service: workspaceService }) : []),
      ...createStructuredDataToolDefinitions({
        store,
        publicationReviewer: input.structuredDataPublicationReviewer
      }),
      ...(config.webAccess.enabled && config.webAccess.fetch.enabled
        ? createWebFetchToolDefinitions({ config: config.webAccess.fetch })
        : []),
      ...createDataSourceTools({ dataSources }),
      createReadSkillTool({ assetSource, conversationOffer }),
      ...platformTools.tools,
      ...(skillPolicy.enabled
        ? [
            createProposeSkillChangeTool({
              assetSource,
              policy: skillPolicy,
              creator: approvalRequestCreator
            })
          ]
        : []),
      ...capabilityContributions.flatMap((contribution) => contribution.tools ?? []),
      ...moduleAssembly.tools,
      ...input.tools
    ]
  });
  assertClientAssemblyValid({ config, tools, approvalRequestHandlers: handlers, modules });
  const toolRegistry = platformTools.registry(tools, getEnabledToolNames(config));
  const modulesStarted = await moduleAssembly.start({
    operationCalls,
    authorizer,
    auditRecorder,
    modelGateway,
    tools: toolRegistry
  });
  const { dataToolSources } = modulesStarted;
  const toolOptions = withConnections(
    connections,
    operationCalls,
    connectionParts,
    dataToolSources
  );
  const defaultModelProvider = modelProviders[0];
  if (!defaultModelProvider) {
    throw new AppError("VALIDATION_FAILED", "At least one model provider is required");
  }
  // A run's events, messages, approval requests and dropped continuations carry the lease of
  // its job (`runFence`). Usage settlement and audit do not, on purpose: a call that was made
  // has cost money and a tool that ran has acted, so both are recorded whoever holds the run.
  const localAgentRuntimeOptions = {
    logger,
    assetSource,
    modelProviders,
    modelBindings: config.modelBindings,
    defaultModelProvider,
    modelProviderContinuationStore: store.conversations,
    modelGateway,
    ...createInstanceAgentTools(operationCalls, toolRegistry, toolOptions),
    conversationOffer,
    webAccess: config.webAccess,
    agentSkillChangesEnabled: skillPolicy.enabled,
    maxSteps: config.runtime.maxSteps,
    repeatedToolCallLimit: config.runtime.repeatedToolCallLimit,
    modelContext: config.modelContext,
    runFailureReporter: createRuntimeFailureReporter(logger),
    artifactReader: managedObjects
      ? { readArtifact: managedObjects.readArtifact.bind(managedObjects) }
      : undefined,
    fileReader: managedObjects
      ? { readFile: managedObjects.readFile.bind(managedObjects) }
      : undefined
  } satisfies WorkerLocalAgentRuntimeOptions;

  const assets = await assetSource.getSnapshot();
  validateConfigAssetBundle({
    agents: assets.agents,
    skills: assets.skills,
    defaultAgentName: assets.defaultAgentName,
    refs: {
      modelProviderIds: modelProviders.map((provider) => provider.id),
      modelBindingIds: config.modelBindings
        .filter((binding) => binding.agentSelectable !== false)
        .map((binding) => binding.id),
      fastModeModelBindingIds: fastModeModelBindingIds(config),
      enabledToolNames: [...getEnabledToolNames(config)]
    }
  });

  const agentIssues = findConfigAssetAgentValidationIssues(config, assets.agents, (binding) =>
    modelGateway.capabilities(binding)
  );
  if (agentIssues.length) {
    throw new AppError("VALIDATION_FAILED", "Client instance assembly is invalid", {
      issues: agentIssues.map((message) => ({ message }))
    });
  }

  return {
    logger,
    env,
    infrastructure,
    config,
    modules,
    clientInstanceId,
    store,
    attachments,
    managedObjects,
    jobRetries: [...jobRetries, ...modulesStarted.jobRetries],
    workspaceObjectStore,
    pages,
    auditRecorder,
    assetSource,
    usageGovernance,
    modelGateway,
    localAgentRuntimeOptions,
    configAssets,
    authorizer,
    operationCalls,
    approvalRequestHandlers: handlers,
    connections,
    modulesStarted,
    async close() {
      await modulesStarted.close();
      await closeCapabilityContributions(capabilityContributions);
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

function resolveAttachmentHandlers(
  handlers: readonly ClientInstanceAttachmentHandler[]
): ChatAttachmentService | undefined {
  if (handlers.length === 0) {
    return undefined;
  }
  if (handlers.length === 1) {
    return handlers[0];
  }
  return createCompositeAttachmentService(handlers);
}

function resolveManagedObjectReaders(
  readers: readonly ClientInstanceManagedObjectReaderContribution[]
) {
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
        (
          await Promise.all(handlers.map((handler) => handler.listDraftAttachments(conversationId)))
        ).flat()
      );
    },
    async uploadDraftAttachment(input) {
      const matchingHandlers = handlers.filter((handler) => handler.acceptsFile(input));
      if (matchingHandlers.length === 0) {
        throw new AppError(
          "BAD_REQUEST",
          "This file type is not supported for uploads in this chat"
        );
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
      return tryAttachmentHandlers(
        handlers,
        (handler) => handler.retryDraftAttachment(input),
        input.attachmentId
      );
    },
    async deleteDraftAttachment(input) {
      return tryAttachmentHandlers(
        handlers,
        (handler) => handler.deleteDraftAttachment(input),
        input.attachmentId
      );
    },
    async deleteConversationAttachments(input) {
      const deletions: Array<
        Awaited<ReturnType<ClientInstanceAttachmentHandler["deleteConversationAttachments"]>>
      > = [];
      // Preserve handler order so namespace-specific byte cleanup runs before broad record markers.
      for (const handler of handlers) {
        deletions.push(await handler.deleteConversationAttachments(input));
      }
      return {
        attachmentCount: deletions.reduce((count, deletion) => count + deletion.attachmentCount, 0),
        fileObjectKeys: uniqueStrings(deletions.flatMap((deletion) => deletion.fileObjectKeys)),
        artifactObjectKeys: uniqueStrings(
          deletions.flatMap((deletion) => deletion.artifactObjectKeys)
        )
      };
    },
    async deleteOrphanedFileObjects(input) {
      const removed: string[] = [];
      for (const handler of handlers) {
        removed.push(...((await handler.deleteOrphanedFileObjects?.(input)) ?? []));
      }
      return uniqueStrings(removed);
    },
    async adoptLegacyAttachments(input) {
      let adopted = 0;
      for (const handler of handlers) {
        adopted += (await handler.adoptLegacyAttachments?.(input)) ?? 0;
      }
      return adopted;
    },
    async readConversationFile(input) {
      return tryAttachmentHandlers(
        handlers,
        (handler) => handler.readConversationFile(input),
        input.fileId
      );
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
      return tryManagedObjectReaders(
        readers,
        (reader) => reader.readArtifact(input),
        input.artifactId
      );
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

function fastModeModelBindingIds(config: ClientInstanceConfig): string[] {
  return config.modelBindings
    .filter((binding) => binding.supportsFastMode)
    .map((binding) => binding.id);
}

function uniqueById<T extends { id: string }>(records: T[]): T[] {
  return [...new Map(records.map((record) => [record.id, record])).values()];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function uniqueManifestEntries<T extends { kind: string; attachmentId: string }>(
  entries: T[]
): T[] {
  return [
    ...new Map(entries.map((entry) => [`${entry.kind}:${entry.attachmentId}`, entry])).values()
  ];
}

async function closeCapabilityContributions(
  contributions: readonly ClientInstanceCapabilityContribution[]
): Promise<void> {
  for (const contribution of [...contributions].reverse()) {
    await contribution.close?.();
  }
}

async function loadConfig(configPath: string | undefined): Promise<ClientInstanceConfig> {
  if (!configPath) {
    throw new AppError("VALIDATION_FAILED", "A client instance config path is required");
  }
  return loadClientInstanceConfigFromFile(configPath);
}
