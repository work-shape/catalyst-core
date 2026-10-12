import {
  createWorkflowRoutes,
  type OperationCalls,
  type RouteRegistration
} from "@vivd-catalyst/chat-server";
import type { RegisteredJobHandler } from "@vivd-catalyst/core";
import {
  createWorkflowEngine,
  noWorkflowDefinitions,
  workflowsModule,
  type WorkflowDefinitionSource,
  type WorkflowEngineOptions
} from "@vivd-catalyst/workflows";
import type { ModuleAssemblyParts, ModuleSeam } from "./module-assembly";

export { workflowsModule };

/** What the engine of one process is built on, once the process has its call path. */
export interface InstanceWorkflowsParts extends Pick<
  ModuleAssemblyParts,
  "modules" | "clientInstanceId" | "stores"
> {
  /** The call path of the process. An operation step calls through it and nothing else. */
  operationCalls: Pick<OperationCalls, "registry" | "deps">;
  /**
   * Where the published definition of a Workflow is read. Without one the instance knows no
   * Workflow, which is what it has until Workflows are stored as assets.
   */
  definitions?: WorkflowDefinitionSource;
  /** Bounds below the release's own, for a test. */
  limits?: WorkflowEngineOptions["limits"];
}

/** What one process has of Workflows: what its server registers and its job worker serves. */
export interface InstanceWorkflows {
  /**
   * The operations of the runs. They are registered whether the module is on or not: where
   * it is off, each call is refused as a call of a module that is off, like every other one.
   */
  routes: readonly RouteRegistration[];
  /** The handler of the step job. None where the module is off. */
  jobHandlers: readonly RegisteredJobHandler[];
}

/**
 * The Workflow engine of one process. Where the module `workflows` is off there is no
 * engine: no run is started or read and no step job is served.
 */
export function createInstanceWorkflows(parts: InstanceWorkflowsParts): InstanceWorkflows {
  if (!parts.modules.isEnabled(workflowsModule.name)) {
    return { routes: [createWorkflowRoutes(undefined)], jobHandlers: [] };
  }
  const engine = createWorkflowEngine({
    clientInstanceId: parts.clientInstanceId,
    stores: parts.stores,
    definitions: parts.definitions ?? noWorkflowDefinitions,
    operationCalls: parts.operationCalls,
    ...(parts.limits ? { limits: parts.limits } : {})
  });
  return { routes: [createWorkflowRoutes(engine)], jobHandlers: engine.jobHandlers };
}

/** The seam of the module: the engine is built once the call path of the process exists. */
export const assembleWorkflows: ModuleSeam = ({ modules, clientInstanceId, stores }) => ({
  start: ({ operationCalls }) =>
    createInstanceWorkflows({ modules, clientInstanceId, stores, operationCalls })
});
