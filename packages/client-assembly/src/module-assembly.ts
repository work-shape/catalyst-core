import type {
  AuditRecorder,
  Authorizer,
  ClientInstanceId,
  JobSchedule,
  Logger,
  ModuleSnapshot,
  OperationSource,
  PlatformStores,
  RegisteredJobHandler,
  SecretResolver
} from "@vivd-catalyst/core";
import type {
  OperationCalls,
  RouteRegistration,
  WorkflowAssetKind
} from "@vivd-catalyst/chat-server";
import type { ClientInstanceConfig } from "@vivd-catalyst/config-schema";
import type { ModelGateway } from "@vivd-catalyst/model-provider";
import type { ToolRegistry } from "@vivd-catalyst/tool-execution";
import type { ToolAssemblyDefinition } from "@vivd-catalyst/tool-sdk";

/**
 * What the seam of a module builds on: the parts of one process that exist before its asset
 * kinds and tools are registered. `stores` holds the module's own store beside the others
 * (`PlatformStores.workflowRuns`, `PlatformStores.dataStores`).
 */
export interface ModuleAssemblyParts {
  config: ClientInstanceConfig;
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
  operationCalls: OperationCalls;
  authorizer: Authorizer;
  auditRecorder: AuditRecorder;
  modelGateway: ModelGateway;
  tools: ToolRegistry;
}

/** What a module adds once it has the call path. A module leaves out what it does not have. */
interface ModuleRuntimeAssembly {
  /** Added to the registry of the call path: the operations of each Asset of the kind. */
  readonly operationSources?: readonly OperationSource[];
  /** Served by the API process, with the schedules. */
  readonly jobHandlers?: readonly RegisteredJobHandler[];
  readonly schedules?: readonly JobSchedule[];
  /** Registered on the server after its own routes. */
  readonly routes?: readonly RouteRegistration[];
}

/**
 * What one module adds to an instance it is on in, in two steps, because what it registers is
 * needed to build the call path that the rest of it needs. Asset kinds and agent tools come
 * first. `start` is called once with the call path and answers the rest.
 */
export interface ModuleAssembly {
  /** Kinds as the asset workflow of the API registers them, which is what that type names. */
  readonly assetKinds?: readonly WorkflowAssetKind[];
  /** Agent tools, registered with the tools of the assembly. */
  readonly tools?: readonly ToolAssemblyDefinition[];
  start?(runtime: ModuleRuntime): ModuleRuntimeAssembly | Promise<ModuleRuntimeAssembly>;
}

/**
 * The seam of one module: its one place in the assembly. It answers nothing where the module
 * is off, so nothing of a module that is off is built.
 */
export type ModuleSeam = (
  parts: ModuleAssemblyParts
) => ModuleAssembly | undefined | Promise<ModuleAssembly | undefined>;

/** What the seams of one process add together, each list in the order of the seams. */
export interface AssembledModules {
  readonly assetKinds: readonly WorkflowAssetKind[];
  readonly tools: readonly ToolAssemblyDefinition[];
  /** Starts every module, adds their operation sources to the call path and answers the rest. */
  start(runtime: ModuleRuntime): Promise<StartedModules>;
}

/** What the started modules leave for the server and the job worker of the process. */
export interface StartedModules {
  readonly jobHandlers: readonly RegisteredJobHandler[];
  readonly schedules: readonly JobSchedule[];
  readonly routes: readonly RouteRegistration[];
}
