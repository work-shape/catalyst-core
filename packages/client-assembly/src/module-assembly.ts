import type { DataStores } from "@work-shape/catalyst-data-stores";
import type { InstanceConnections } from "./connections";
import type {
  PublishNarrativeStoredData,
  AuditRecorder,
  ApprovalRequestHandler,
  Authorizer,
  ClientInstanceId,
  DataToolSource,
  JobRetry,
  JobSchedule,
  KnowledgeBackend,
  KnowledgeFiles,
  KnowledgeHitDocuments,
  Logger,
  Notices,
  ModuleSnapshot,
  OperationSource,
  PlatformStores,
  RegisteredJobHandler,
  SecretResolver
} from "@work-shape/catalyst-core";
import type {
  OperationCalls,
  RouteRegistration,
  WorkflowAssetKind
} from "@work-shape/catalyst-server";
import type { ClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import type { ModelGateway } from "@work-shape/catalyst-model-provider";
import type { ToolRegistry } from "@work-shape/catalyst-tool-execution";
import type { ToolAssemblyDefinition } from "@work-shape/catalyst-tool-sdk";

/**
 * What the seam of a module builds on: the parts of one process that exist before its asset
 * kinds and tools are registered. `stores` holds the module's own store beside the others
 * (`PlatformStores.workflowRuns`, `PlatformStores.dataStores`).
 */
export interface ModuleAssemblyParts {
  config: ClientInstanceConfig;
  connections?: InstanceConnections;
  modules: ModuleSnapshot;
  clientInstanceId: ClientInstanceId;
  secrets: SecretResolver;
  stores: PlatformStores;
  logger: Logger;
}

/**
 * What exists once the call path of the process does: a module calls operations as a step of a
 * run does, asks whether a principal may, calls a model and runs the tools of the instance.
 */
interface ModuleRuntime {
  knowledgeFieldExtractor?: import("@work-shape/catalyst-core").KnowledgeFieldExtractor;
  notices?: (stores: PlatformStores) => Notices;
  operationCalls: OperationCalls;
  authorizer: Authorizer;
  auditRecorder: AuditRecorder;
  modelGateway: ModelGateway;
  tools: ToolRegistry;
  /**
   * The files a person can open and the instance's store of files, for a module that keeps
   * copies of them. Absent where the process has no store of files.
   */
  files?: KnowledgeFiles;
}

/** What a module adds once it has the call path. A module leaves out what it does not have. */
interface ModuleRuntimeAssembly {
  /** Served by the API process, with the schedules. */
  readonly jobHandlers?: readonly RegisteredJobHandler[];
  readonly schedules?: readonly JobSchedule[];
  /** How an ended job of one of the module's kinds is retried by hand. */
  readonly jobRetries?: readonly JobRetry[];
  /** Registered on the server after its own routes. */
  readonly routes?: readonly RouteRegistration[];
  /** Operations of the module's Assets as tools an agent may carry, beside the Connections'. */
  readonly dataToolSources?: readonly DataToolSource[];
  /** What the document tools read on a Knowledge Base search hit's file id (KB-7c). */
  readonly knowledgeDocuments?: KnowledgeHitDocuments;
  /** Gives back what the module opened, such as a pool. Called when the process closes. */
  close?(): Promise<void>;
}

/**
 * What one module adds to an instance it is on in, in steps, because what it registers is
 * needed to build the call path that the rest of it needs. Asset kinds and agent tools come
 * first. With the call path, `operationSources` of every module is asked and added to it, and
 * only then is any module started: a module that starts finds the operations of every other.
 */
export interface ModuleAssembly {
  /** Kinds as the asset workflow of the API registers them, which is what that type names. */
  readonly approvalRequestHandlers?: readonly ApprovalRequestHandler[];
  readonly assetKinds?: readonly WorkflowAssetKind[];
  /** Agent tools, registered with the tools of the assembly. */
  readonly tools?: readonly ToolAssemblyDefinition[];
  /** Where a Knowledge Base reads the tables it describes, where this module offers that. */
  readonly knowledgeBackend?: KnowledgeBackend;
  readonly knowledgeSources?: DataStores["knowledgeSources"];
  readonly knowledgeSourceJobs?: DataStores["knowledgeSourceJobs"];
  /** Who sees which stored data, for the publish question's sentence (PUBQ-1). */
  readonly publishNarrativeData?: PublishNarrativeStoredData;
  /** The operations of each Asset of the kind. Built here and resolved when one is called. */
  operationSources?(runtime: ModuleRuntime): readonly OperationSource[];
  start?(runtime: ModuleRuntime): ModuleRuntimeAssembly | Promise<ModuleRuntimeAssembly>;
}

/**
 * The seam of one module: its one place in the assembly. It answers nothing where the module
 * is off, so nothing of a module that is off is built. `earlier` are the assemblies of the
 * seams before it, in their order, for what one module offers another.
 */
export type ModuleSeam = (
  parts: ModuleAssemblyParts,
  earlier: readonly ModuleAssembly[]
) => ModuleAssembly | undefined | Promise<ModuleAssembly | undefined>;

/** What the seams of one process add together, each list in the order of the seams. */
export interface AssembledModules {
  readonly approvalRequestHandlers: readonly ApprovalRequestHandler[];
  readonly assetKinds: readonly WorkflowAssetKind[];
  readonly tools: readonly ToolAssemblyDefinition[];
  /** The first module's answer on stored data for the publish question, where one is on. */
  readonly publishNarrativeData?: PublishNarrativeStoredData;
  /** Adds every module's operation sources to the call path, then starts each module. */
  start(runtime: ModuleRuntime): Promise<StartedModules>;
}

/** What the started modules leave for the server and the job worker of the process. */
export interface StartedModules {
  readonly jobHandlers: readonly RegisteredJobHandler[];
  readonly schedules: readonly JobSchedule[];
  readonly jobRetries: readonly JobRetry[];
  readonly routes: readonly RouteRegistration[];
  readonly dataToolSources: readonly DataToolSource[];
  /** The first started module's documents of Knowledge Bases, where one offers them. */
  readonly knowledgeDocuments?: KnowledgeHitDocuments;
  /** Closes every started module, the last started first. */
  close(): Promise<void>;
}
