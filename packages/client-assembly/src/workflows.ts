import { workflowsConfigSchema } from "@work-shape/catalyst-config-schema";
import {
  createWorkflowRoutes,
  workflowRunAsPrincipal,
  type OperationCalls,
  type RouteRegistration,
  type WorkflowListEntry
} from "@work-shape/catalyst-server";
import { AppError, type JobSchedule, type RegisteredJobHandler } from "@work-shape/catalyst-core";
import {
  codeStepIssues,
  createWorkflowEngine,
  noWorkflowStepFiles,
  workflowDefinitionStartIssues,
  workflowRunPrincipal,
  workflowStartIssues,
  workflowStepFileIssues,
  workflowsModule,
  type WorkflowDefinitionSource,
  type WorkflowEngineOptions
} from "@work-shape/catalyst-workflows";
import type { ModuleAssemblyParts, ModuleSeam } from "./module-assembly";
import {
  createWorkflowAssetDefinitions,
  createWorkflowAssetKind,
  createWorkflowAssetStepFiles,
  publishedWorkflowsOf
} from "./workflow-assets";

export { workflowsModule };

/** What the engine of one process is built on, once the process has its call path. */
export interface InstanceWorkflowsParts extends Pick<
  ModuleAssemblyParts,
  "modules" | "clientInstanceId" | "stores"
> {
  /** The call path of the process. An operation step calls through it and nothing else. */
  operationCalls: Pick<OperationCalls, "registry" | "deps">;
  /** Validated at startup, with the release schema's default for direct assembly callers. */
  stepSlots?: number;
  /**
   * Where the published definition of a Workflow is read, in place of the instance's own
   * source: the published revisions of its Workflow assets. For a test of the engine.
   */
  definitions?: WorkflowDefinitionSource;
  /** Bounds below the release's own, for a test. */
  limits?: WorkflowEngineOptions["limits"];
  /** The clock of the engine, for a test of due times. */
  now?: WorkflowEngineOptions["now"];
  /** The time zone the cron expressions of `schedule` triggers are read in. UTC when left out. */
  timeZone?: string;
  /**
   * Where the script of a code step is read, in place of the instance's own source: the step
   * files of the revision of the Workflow asset a run was started on. For a test of the
   * engine, which hands in its definitions as well: such definitions are no assets, so
   * without this they have no script.
   */
  stepFiles?: WorkflowEngineOptions["stepFiles"];
  /**
   * Set where the instance runs a command worker with a sandbox. Without it a code step
   * fails at once, as no process would ever run its script.
   */
  codeRunner?: WorkflowEngineOptions["codeRunner"];
  /** `retention.workflowStepDataDays` of release config. The release's default when left out. */
  stepDataDays?: number;
  /** Batch sizes of the job that removes run data, for a test. */
  pruneBatch?: WorkflowEngineOptions["pruneBatch"];
}

/** What one process has of Workflows: what its server registers and its job worker serves. */
export interface InstanceWorkflows {
  /**
   * The operations of the runs. They are registered whether the module is on or not: where
   * it is off, each call is refused as a call of a module that is off, like every other one.
   */
  routes: readonly RouteRegistration[];
  /**
   * The handlers of the step job, of the schedule job and of the job that removes old run
   * data. None where the module is off.
   */
  jobHandlers: readonly RegisteredJobHandler[];
  /** The job that removes old run data, daily. None where the module is off. */
  jobSchedules: readonly JobSchedule[];
  /** Removes the values of the runs that are due, as the daily job does. */
  pruneRunData(): Promise<{ runs: number; stepRuns: number; batches: number }>;
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
      routes: [createWorkflowRoutes(undefined, parts)],
      jobHandlers: [],
      jobSchedules: [],
      pruneRunData: () => Promise.resolve({ runs: 0, stepRuns: 0, batches: 0 }),
      planSchedules: () => Promise.resolve([]),
      planSchedule: () => Promise.resolve(undefined)
    };
  }
  const { clientInstanceId, stores, operationCalls } = parts;
  const assets = createWorkflowAssetDefinitions({
    clientInstanceId,
    configAssets: stores.configAssets
  });
  const given = parts.definitions;
  const stepFiles =
    parts.stepFiles ??
    (given
      ? noWorkflowStepFiles
      : createWorkflowAssetStepFiles({ clientInstanceId, configAssets: stores.configAssets }));
  const engine = createWorkflowEngine({
    stepSlots: parts.stepSlots ?? workflowsConfigSchema.parse({}).stepSlots,
    clientInstanceId,
    stores,
    definitions: given ?? assets,
    operationCalls,
    ...(parts.limits ? { limits: parts.limits } : {}),
    ...(parts.now ? { now: parts.now } : {}),
    ...(parts.timeZone === undefined ? {} : { timeZone: parts.timeZone }),
    stepFiles,
    ...(parts.codeRunner ? { codeRunner: parts.codeRunner } : {}),
    ...(parts.stepDataDays === undefined ? {} : { stepDataDays: parts.stepDataDays }),
    ...(parts.pruneBatch ? { pruneBatch: parts.pruneBatch } : {})
  });
  /**
   * The list of the instance: every published Workflow, with what a start by hand of it is
   * refused for now. One the engine of this release does not run is listed with the engine's
   * reasons, never left out, so a page says why it cannot be started instead of guessing.
   */
  async function listWorkflows(): Promise<WorkflowListEntry[]> {
    const published = await (given ? publishedWorkflowsOf(given) : assets.published());
    const last = await stores.workflowRuns.listLastRuns({
      clientInstanceId,
      workflows: published.map((workflow) => workflow.id)
    });
    const entries: WorkflowListEntry[] = [];
    for (const { id, assetId, name, description, revisionId, definition, files } of published) {
      // The active principal answers both whether a run can start and whom it acts as.
      const principal = definition.ok
        ? await workflowRunPrincipal(stores.apiAccess, clientInstanceId, definition.manifest)
        : undefined;
      const reasons = definition.ok
        ? [
            ...(await workflowStartIssues(definition.manifest, {
              principal,
              clientInstanceId,
              principals: stores.apiAccess,
              registry: operationCalls.registry
            })),
            // A script that is missing or refused, as a start says it. The files of an asset
            // came with its published revision, so they cost no further read.
            ...(files
              ? workflowStepFileIssues(definition.manifest, files)
              : await codeStepIssues({ revisionId, manifest: definition.manifest }, stepFiles))
          ]
        : workflowDefinitionStartIssues(definition.issues);
      const lastRun = last.get(id);
      entries.push({
        id,
        ...(assetId === undefined ? {} : { assetId }),
        name,
        ...(description === undefined ? {} : { description }),
        definitionRevisionId: revisionId,
        runnable: reasons.length === 0,
        reasons,
        ...(definition.ok ? { inputs: definition.manifest.inputs } : {}),
        ...(principal ? { runsAs: principal.displayLabel } : {}),
        ...(lastRun ? { lastRun } : {})
      });
    }
    return entries;
  }
  return {
    routes: [
      createWorkflowRoutes(
        {
          ...engine,
          listWorkflows,
          async test({ workflow, ...start }) {
            // Definitions a test hands in are published revisions without a draft.
            const draft = given ? undefined : await assets.draft(workflow);
            if (!draft) throw new AppError("NOT_FOUND", `There is no Workflow '${workflow}'`);
            // The principal bounds the test run and lends it nothing: it is asked to exist and
            // be active, and no right over it is asked of the tester (ADR-0031).
            await workflowRunAsPrincipal(
              { clientInstanceId, apiAccess: stores.apiAccess },
              { workflow, runAs: draft.manifest.runAs }
            );
            return engine.test({ draft, ...start });
          },
          // Definitions a test hands in are no assets: a right on them is decided by name.
          assetIdOf: (workflow) => (given ? Promise.resolve(undefined) : assets.assetIdOf(workflow))
        },
        parts
      )
    ],
    jobHandlers: engine.jobHandlers,
    jobSchedules: engine.jobSchedules,
    pruneRunData: () => engine.pruneRunData(),
    planSchedules: engine.planSchedules,
    planSchedule: engine.planSchedule
  };
}

/**
 * The seam of the module. Where it is on, the instance registers the asset kind `workflow`;
 * the engine is built once the call path of the process exists. The kind queues the job of a
 * schedule when its definition is published. A process that starts plans the schedules of
 * what is published as well, so a Workflow whose job was lost has its next due time queued.
 */
export const assembleWorkflows: ModuleSeam = ({ config, modules, clientInstanceId, stores }) => {
  // The instance's time zone: the schedules of its Workflows are read on its clock, by the
  // engine and by the kind that queues the job of a schedule when its definition is published.
  const { timeZone } = config.clientInstance;
  const zone = timeZone === undefined ? {} : { timeZone };
  return {
    ...(modules.isEnabled(workflowsModule.name)
      ? {
          assetKinds: [
            createWorkflowAssetKind({
              clientInstanceId,
              apiAccess: stores.apiAccess,
              configAssets: stores.configAssets,
              access: stores.access,
              ...zone
            })
          ]
        }
      : {}),
    async start({ operationCalls }) {
      const workflows = createInstanceWorkflows({
        modules,
        clientInstanceId,
        stores,
        operationCalls,
        stepSlots: config.workflows.stepSlots,
        ...zone,
        // The command worker runs the scripts of code steps. An instance without Execution
        // Workspaces or without a sandbox has no such worker, and its engine knows.
        ...(config.executionWorkspaces.enabled && config.infrastructure.sandbox
          ? { codeRunner: { timeoutSeconds: config.workflows.codeSteps.timeoutSeconds } }
          : {}),
        stepDataDays: config.retention.workflowStepDataDays
      });
      await workflows.planSchedules();
      return {
        routes: workflows.routes,
        jobHandlers: workflows.jobHandlers,
        schedules: workflows.jobSchedules
      };
    }
  };
};
