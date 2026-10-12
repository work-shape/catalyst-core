import type {
  ClientInstanceId,
  JobSchedule,
  Logger,
  ModuleSnapshot,
  OperationSource,
  PlatformStores,
  RegisteredJobHandler,
  SecretResolver
} from "@vivd-catalyst/core";
import type { WorkflowAssetKind } from "@vivd-catalyst/chat-server";
import type { ClientInstanceConfig } from "@vivd-catalyst/config-schema";

/** What the seam of a module builds on: the parts of one process that exist before it. */
export interface ModuleAssemblyParts {
  config: ClientInstanceConfig;
  modules: ModuleSnapshot;
  clientInstanceId: ClientInstanceId;
  secrets: SecretResolver;
  stores: PlatformStores;
  logger: Logger;
}

/**
 * What one module adds to an instance it is on in. The assembly registers the asset kinds,
 * adds the operation sources to the call path, and the API process serves the job handlers
 * with their schedules. A module leaves out what it does not have.
 */
export interface ModuleAssembly {
  /** Kinds as the asset workflow of the API registers them, which is what that type names. */
  readonly assetKinds?: readonly WorkflowAssetKind[];
  readonly operationSources?: readonly OperationSource[];
  readonly jobHandlers?: readonly RegisteredJobHandler[];
  readonly schedules?: readonly JobSchedule[];
}

/**
 * The seam of one module: its one place in the assembly. It answers nothing where the module
 * is off, so nothing of a module that is off is built.
 */
export type ModuleSeam = (
  parts: ModuleAssemblyParts
) => ModuleAssembly | undefined | Promise<ModuleAssembly | undefined>;
