import type { ResultShaper } from "@work-shape/catalyst-core";
import type { CatalogueEntry } from "@work-shape/catalyst-connections";
import { createLogger } from "./logger";
import {
  StoreBackedAgentRuntime,
  createAgentRunSignal,
  type AgentRunJobsOptions,
  type WorkerLocalAgentRuntimeOptions
} from "@work-shape/catalyst-agent-runtime";
import {
  RUN_AGENT_TOOL_NAME,
  StoreBackedAuditRecorder,
  type AgentConfig,
  type ApprovalRequestHandlerRegistry,
  type StructuredDataPublicationReviewer
} from "@work-shape/catalyst-core";
import {
  createSkillChangeApprovalHandler,
  createChatServer,
  createChatServerJobs
} from "@work-shape/catalyst-server";
import type { ChatAttachmentService, ChatServerOptions } from "@work-shape/catalyst-server";
import { createManagedObjectAccess } from "@work-shape/catalyst-capability-sdk";
import {
  AppError,
  KNOWLEDGE_JOB_KINDS,
  type ConnectorTypeDefinition,
  type HttpRuntime,
  type JobWorker,
  type KnowledgeHitDocuments,
  type PlatformStores,
  type SecretResolver
} from "@work-shape/catalyst-core";
import {
  type ClientInstanceConfig,
  formerReleaseToolWarnings,
  getClientInstanceId,
  getModelProviderConfigs,
  loadClientInstanceConfigFromFile,
  validateConfigAssetBundle
} from "@work-shape/catalyst-config-schema";
import {
  createDataSourceTools,
  createDataSourceRegistry
} from "@work-shape/catalyst-postgres-connector";
import { createWebFetchToolDefinitions } from "@work-shape/catalyst-web-access";
import {
  createBuiltInToolDefinitions,
  createConsoleWorkspaceCommandTelemetry,
  createMailSendTool,
  createReadSkillTool,
  createProposeSkillChangeTool,
  createStructuredDataToolDefinitions,
  createWorkspaceToolDefinitions,
  WorkspaceCommandService
} from "@work-shape/catalyst-tool-execution";
import type { ToolAssemblyDefinition } from "@work-shape/catalyst-tool-sdk";
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
import { offeredSkillNames, shippedSkillNamesOf, shippedSkillsOf } from "./shipped-skills";
import { SHIPPED_AGENT_NAMES, shippedAgentsOf } from "./shipped-agents";
import { workshaperAgent } from "./workshaper";
import {
  createClientInstanceMail,
  createInstanceNotices,
  mailSendToolRights,
  mailSendersOf,
  outboundMailOf,
  registerInstanceMailSend,
  releaseToolNames
} from "./mail";
import type {
  ClientInstanceAttachmentHandler,
  ClientInstanceCapabilityContribution,
  ClientInstanceCapability,
  ClientInstanceManagedObjectReaderContribution
} from "./capabilities";
import { readClientInstanceEnv, type ClientInstanceEnv } from "./env";
import {
  createFilesStore,
  createInstanceInfrastructure,
  createWorkspacesStore
} from "./infrastructure";
import { createKnowledgeFiles } from "./knowledge-files";
import { createInfrastructureWorkflow } from "./infrastructure";
import { createInProcessAgentRunWorker, type AgentRunWorkerPlacement } from "./agent-run-jobs";
import { createInstancePages, createInstanceWorkspaceOpen } from "./pages";
import type { KnowledgeWorkerPlacement } from "./knowledge";
import { createJobWorker } from "./job-worker";
import { createPlatformTools } from "./conversation-offer";
import { PLATFORM_INSTRUCTIONS, agentListableToolNames } from "./platform-orientation";
import { assembleModules, endResolveOnlyRun, resolveInstanceModules } from "./modules";
import { createRuntimeFailureReporter } from "./runtime-error-logging";
import { createPlatformStore } from "./store";
import { createConfigAssetReferences, fastModeModelBindingIds } from "./tool-references";
import { createToolDefinitions } from "./tools";
import {
  createExecutionWorkspaceManagedObjectReader,
  createExecutionWorkspaceSourceAttachmentHandler,
  unsupportedAttachmentMessage
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
  /** The catalogue entries of this build; release config names the ones it offers. */
  catalogue?: readonly CatalogueEntry[];
  /** Synchronous result transformations registered by this build. */
  resultShapers?: Readonly<Record<string, ResultShaper>>;
  /** The capabilities of this build, the same ones every process of the instance is given. */
  capabilities: readonly ClientInstanceCapability[];
  structuredDataPublicationReviewer?: StructuredDataPublicationReviewer;
  approvalRequestHandlers?: ApprovalRequestHandlerRegistry;
  /** What the calls of operations run with beyond the instance's own defaults. For tests. */
  operations?: ChatServerOptions["operations"];
  allowedOrigins?: string | string[];
  agentRunWorker?: AgentRunWorkerPlacement;
  /** Where Knowledge Base ingestion executes. Search and operations stay in the API. */
  knowledgeWorker?: KnowledgeWorkerPlacement;
  /**
   * Which Agent Runs nobody watches, so a confirmation they ask waits in their person's Inbox.
   * A scheduled start says so once EW-8 builds it. For tests until then.
   */
  unattendedRuns?: AgentRunJobsOptions["unattended"];
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
      personalApiKeys: execution.modules.isEnabled("personalApiKeys"),
      allowedOrigins: input.allowedOrigins
    });
  const serverOptions: ChatServerOptions = {
    logger,
    config,
    modules: execution.modules,
    infrastructure: createInfrastructureWorkflow(
      config,
      execution.infrastructure,
      store,
      input.knowledgeWorker === "separate" && execution.modules.isEnabled("knowledge")
        ? [
            {
              id: "knowledge-worker",
              class: "workers",
              type: "knowledge-worker",
              origin: "operator",
              external: false,
              secrets: [],
              reportedByJobKind: KNOWLEDGE_JOB_KINDS.index
            }
          ]
        : []
    ),
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
    mail: execution.noticeMail,
    mailSenders: mailSendersOf(config),
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
    handlers: [...serverJobs.handlers, ...execution.modulesStarted.jobHandlers].filter(
      (handler) =>
        input.knowledgeWorker !== "separate" ||
        !Object.values(KNOWLEDGE_JOB_KINDS).some((kind) => kind === handler.kind.kind)
    ),
    schedules: [...serverJobs.schedules, ...execution.modulesStarted.schedules].filter(
      (schedule) =>
        input.knowledgeWorker !== "separate" ||
        !Object.values(KNOWLEDGE_JOB_KINDS).some((kind) => kind === schedule.kind.kind)
    )
  });
  const agentRunJobs = inProcess
    ? createInProcessAgentRunWorker(execution, inProcess, input.unattendedRuns)
    : undefined;

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
  input: Omit<
    CreateClientInstanceAppInput,
    "agentRunWorker" | "knowledgeWorker" | "allowedOrigins"
  >,
  processOptions: { poolSize?: number } = {}
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
    poolSize: processOptions.poolSize ?? config.infrastructure.database.poolSize,
    logger
  });
  const connectionParts = { config, modules, clientInstanceId, secrets, stores: store, logger };
  const connections = await createInstanceConnections(
    connectionParts,
    input.connectorTypes,
    input.catalogue,
    input.resultShapers
  );
  const moduleAssembly = await assembleModules({
    ...connectionParts,
    ...(connections ? { connections } : {})
  });
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
  // The Knowledge Base module starts after the capabilities: their tools reach its documents
  // once it has.
  let knowledgeDocuments: KnowledgeHitDocuments | undefined;
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
    knowledgeDocuments: {
      open: async (request) => knowledgeDocuments?.open(request)
    },
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
        capabilityAttachmentHandlers,
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
  const references = createConfigAssetReferences(config, modelProviders, modules);
  const { validationRefs } = references;
  validationRefs.isToolAvailable = (agent, name) =>
    findConfigAssetAgentValidationIssues(config, [{ ...agent, toolNames: [name] }], (binding) =>
      modelGateway.capabilities(binding)
    ).length === 0;
  const assetSource = createConfigAssetSource({
    store: store.configAssets,
    clientInstanceId,
    references: { ...validationRefs, offToolModule: (name) => modules.offModuleOf("tool", name) },
    onUnavailable(
      agentName,
      { unavailableTools, unavailableSkills, unavailableModels, chatAvailable }
    ) {
      logger.warn(
        { agentName, unavailableTools, unavailableSkills, unavailableModels, chatAvailable },
        "Stored agent references unavailable items"
      );
    },
    onFormerToolNames(agentName, warnings) {
      for (const warning of warnings) logger.warn({ agentName }, warning);
    }
  });
  for (const warning of formerReleaseToolWarnings(config.tools.map((tool) => tool.name))) {
    logger.warn(warning);
  }
  // Writes check changed agents strictly. Unavailable references of an unchanged stored
  // agent do not stand in the way of repairing another agent or writing a skill.
  const validateAgents = (_agents: AgentConfig[], changed: AgentConfig[]) => [
    ...findModuleOffToolIssues(modules, changed),
    ...findConfigAssetAgentValidationIssues(config, changed, (binding) =>
      modelGateway.capabilities(binding)
    )
  ];
  const configAssets: Parameters<typeof createChatServer>[0]["configAssets"] = {
    store: store.configAssets,
    source: assetSource,
    kinds: createInstanceAssetKinds({
      agent: { config, validationRefs, validateAgents, shippedAgentNames: SHIPPED_AGENT_NAMES },
      skill: { config, shippedSkillNames: shippedSkillNamesOf(capabilities) },
      connections,
      modules,
      moduleKinds: moduleAssembly.assetKinds
    }),
    validationRefs,
    tools: references.tools,
    platformInstructions: PLATFORM_INSTRUCTIONS
  };
  const approvalRequestHandlers = new Map(input.approvalRequestHandlers ?? []);
  for (const handler of moduleAssembly.approvalRequestHandlers) {
    if (approvalRequestHandlers.has(handler.kind))
      throw new AppError(
        "VALIDATION_FAILED",
        `The ${handler.kind} approval kind is platform-owned`
      );
    approvalRequestHandlers.set(handler.kind, handler);
  }
  const reconnectNotice = connections?.reconnectNotice;
  if (reconnectNotice) {
    if (approvalRequestHandlers.has(reconnectNotice.kind)) {
      throw new AppError(
        "VALIDATION_FAILED",
        `The ${reconnectNotice.kind} approval kind is platform-owned`
      );
    }
    approvalRequestHandlers.set(reconnectNotice.kind, reconnectNotice);
  }
  const skillPolicy = config.administration.agentConfiguration.agentSkillChanges;
  if (skillPolicy.enabled) {
    if (approvalRequestHandlers.has("skill_change")) {
      throw new AppError("VALIDATION_FAILED", "The skill_change approval kind is platform-owned");
    }
    const handler = createSkillChangeApprovalHandler({
      config,
      clientInstanceId,
      configAssets,
      stores: store
    });
    approvalRequestHandlers.set(handler.kind, handler);
  }
  const platformTools = createPlatformTools({
    stores: store,
    modules,
    connections,
    dataTools: () => configAssets.dataTools,
    dataToolDescribeTimeoutMs: config.runtime.dataToolDescribeTimeoutMs,
    toolRights: mailSendToolRights(config),
    policy: {
      instanceDefaults: config.policy.defaults,
      centralSettings: () => operationCalls.deps.policy.centralSettings()
    }
  });
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
    operations: input.operations,
    ...(moduleAssembly.publishNarrativeData
      ? { publishStoredData: moduleAssembly.publishNarrativeData }
      : {})
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
  const workspaceOpen = createInstanceWorkspaceOpen({ modules, stores: store, workspaceService });
  const tools = createToolDefinitions({
    config,
    tools: [
      ...createBuiltInToolDefinitions(config.views, { apps: workspaceOpen }),
      ...(workspaceService ? createWorkspaceToolDefinitions({ service: workspaceService }) : []),
      ...createStructuredDataToolDefinitions({
        store,
        publicationReviewer: input.structuredDataPublicationReviewer
      }),
      ...(config.webAccess.enabled && config.webAccess.fetch.enabled
        ? createWebFetchToolDefinitions({ config: config.webAccess.fetch })
        : []),
      ...createDataSourceTools({ dataSources }),
      createReadSkillTool({
        assetSource,
        conversationOffer,
        saveApproval: platformTools.skillSaveApproval
      }),
      ...platformTools.tools,
      ...(outboundMailOf(config) ? [createMailSendTool()] : []),
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
  references.describe(tools);
  const toolRegistry = platformTools.registry(tools, releaseToolNames(config));
  const shippedSkills = shippedSkillsOf({
    modules,
    capabilities,
    hasTool: (toolName) => toolRegistry.has(toolName)
  });
  // Asked of an agent with no model of its own, as a shipped agent is until the instance gives
  // it one: a tool its default model cannot run does not ship.
  const shippedAgentProbe: AgentConfig = workshaperAgent({ toolNames: [], skillNames: [] });
  const shippedAgents = shippedAgentsOf({
    modules,
    listableToolNames: agentListableToolNames(releaseToolNames(config)),
    runsTool: (name) =>
      modules.offModuleOf("tool", name) === undefined &&
      validationRefs.isToolAvailable?.(shippedAgentProbe, name) !== false,
    shippedSkills,
    offeredSkillNames: offeredSkillNames(undefined, modules),
    runAgentToolName: RUN_AGENT_TOOL_NAME
  });
  const noticeMail = await createClientInstanceMail({
    config,
    registry: infrastructure.registry,
    context: infrastructure.context
  });
  registerInstanceMailSend(operationCalls.registry, {
    config,
    clientInstanceId,
    stores: store,
    mail: noticeMail
  });
  const modulesStarted = await moduleAssembly.start({
    knowledgeFieldExtractor: capabilityContributions.find((part) => part.knowledgeFieldExtractor)
      ?.knowledgeFieldExtractor,
    notices: createInstanceNotices({ config, clientInstanceId, mail: noticeMail }),
    operationCalls,
    authorizer,
    auditRecorder,
    modelGateway,
    tools: toolRegistry,
    ...(config.infrastructure.objectStorage.files === undefined
      ? {}
      : {
          files: createKnowledgeFiles({
            clientInstanceId,
            stores: store,
            attachments,
            objects: await createFilesStore(config, infrastructure.context)
          })
        })
  });
  const { dataToolSources } = modulesStarted;
  knowledgeDocuments = modulesStarted.knowledgeDocuments;
  const toolOptions = withConnections(
    connections,
    operationCalls,
    connectionParts,
    dataToolSources
  );
  if (toolOptions.dataTools) configAssets.dataTools = toolOptions.dataTools;
  validationRefs.offToolModule = (name) => modules.offModuleOf("tool", name);
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
    // A run reads how its subagents ended at the end of the step that started them.
    subagents: store.childAgentRuns,
    webAccess: config.webAccess,
    personalData: {
      personalConversation: async (id, runId) =>
        (await operationCalls.deps.policy.personalConversation?.(id, runId)) ?? true,
      operations: operationCalls.registry
    },
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
    stored: true,
    agents: assets.agents,
    skills: assets.skills,
    defaultAgentName: assets.defaultAgentName,
    refs: {
      modelProviderIds: modelProviders.map((provider) => provider.id),
      modelBindingIds: config.modelBindings
        .filter((binding) => binding.agentSelectable !== false)
        .map((binding) => binding.id),
      fastModeModelBindingIds: fastModeModelBindingIds(config),
      enabledToolNames: agentListableToolNames(releaseToolNames(config))
    }
  });

  return {
    logger,
    env,
    infrastructure,
    config,
    modules,
    clientInstanceId,
    store,
    shippedSkills,
    shippedAgents,
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
    noticeMail,
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
        throw new AppError("BAD_REQUEST", unsupportedAttachmentMessage(input.locale));
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
        fileObjectKeys: [...new Set(deletions.flatMap((deletion) => deletion.fileObjectKeys))],
        artifactObjectKeys: [
          ...new Set(deletions.flatMap((deletion) => deletion.artifactObjectKeys))
        ]
      };
    },
    async deleteOrphanedFileObjects(input) {
      const removed: string[] = [];
      for (const handler of handlers) {
        removed.push(...((await handler.deleteOrphanedFileObjects?.(input)) ?? []));
      }
      return [...new Set(removed)];
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

function uniqueById<T extends { id: string }>(records: T[]): T[] {
  return [...new Map(records.map((record) => [record.id, record])).values()];
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
