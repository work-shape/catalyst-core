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
  /** The clock of the engine, for a test of due times. */
  now?: WorkflowEngineOptions["now"];
  /** The time zone the cron expressions of `schedule` triggers are read in. UTC when left out. */
  timeZone?: string;
}

/** What one process has of Workflows: what its server registers and its job worker serves. */
export interface InstanceWorkflows {
  /**
   * The operations of the runs. They are registered whether the module is on or not: where
   * it is off, each call is refused as a call of a module that is off, like every other one.
   */
  routes: readonly RouteRegistration[];
  /** The handlers of the step job and of the schedule job. None where the module is off. */
  jobHandlers: readonly RegisteredJobHandler[];
  /**
   * Queues the job of the next due time of every published Workflow that has a schedule and
   * has none queued. Nothing where the module is off.
   */
  planSchedules(): Promise<{ workflow: string; dueAt: string }[]>;
  /**
   * The same for one Workflow, for whoever publishes its definition or takes it back. Nothing
   * where the module is off or the Workflow has no schedule.
   */
  planSchedule(workflow: string): Promise<{ workflow: string; dueAt: string } | undefined>;
}

/**
 * The Workflow engine of one process. Where the module `workflows` is off there is no
 * engine: no run is started or read and no step job is served.
 */
export function createInstanceWorkflows(parts: InstanceWorkflowsParts): InstanceWorkflows {
  if (!parts.modules.isEnabled(workflowsModule.name)) {
    return {
      routes: [createWorkflowRoutes(undefined)],
      jobHandlers: [],
      planSchedules: () => Promise.resolve([]),
      planSchedule: () => Promise.resolve(undefined)
    };
  }
  const engine = createWorkflowEngine({
    clientInstanceId: parts.clientInstanceId,
    stores: parts.stores,
    definitions: parts.definitions ?? noWorkflowDefinitions,
    operationCalls: parts.operationCalls,
    ...(parts.limits ? { limits: parts.limits } : {}),
    ...(parts.now ? { now: parts.now } : {}),
    ...(parts.timeZone === undefined ? {} : { timeZone: parts.timeZone })
  });
  return {
    routes: [createWorkflowRoutes(engine)],
    jobHandlers: engine.jobHandlers,
    planSchedules: engine.planSchedules,
    planSchedule: engine.planSchedule
  };
}

/**
 * The seam of the module: the engine is built once the call path of the process exists. A
 * process that starts plans the schedules of what is published, so a Workflow whose job was
 * lost, or that was published while no process ran, has its next due time queued.
 */
export const assembleWorkflows: ModuleSeam = ({ config, modules, clientInstanceId, stores }) => ({
  async start({ operationCalls }) {
    const { timeZone } = config.clientInstance;
    const workflows = createInstanceWorkflows({
      modules,
      clientInstanceId,
      stores,
      operationCalls,
      // The instance's time zone: the schedules of its Workflows are read on its clock.
      ...(timeZone === undefined ? {} : { timeZone })
    });
    await workflows.planSchedules();
    return { routes: workflows.routes, jobHandlers: workflows.jobHandlers };
  }
});
