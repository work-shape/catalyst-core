import { WORKFLOW_RUN_JOB_KINDS, defineModule } from "@vivd-catalyst/core";

/** The operations of the API that belong to the module. Each is off where the module is. */
export const WORKFLOW_OPERATION_IDS = [
  "workflows.list",
  "workflows.start",
  "workflows.get_run",
  "workflows.list_runs",
  "workflows.list_step_runs",
  "workflows.cancel_run"
] as const;

/**
 * Workflows: their runs and the engine that executes their steps on the job executor. Where
 * the module is off, no run is started, read or cancelled and no step job is served.
 */
export const workflowsModule = defineModule({
  name: "workflows",
  operations: WORKFLOW_OPERATION_IDS,
  jobKinds: [WORKFLOW_RUN_JOB_KINDS.executeStep, WORKFLOW_RUN_JOB_KINDS.fireSchedule]
});

export { lastDueWithin, nextDueAfter, parseCron } from "./cron";
export {
  WORKFLOW_EXECUTED_STEP_TYPES,
  parseWorkflowManifest,
  readWorkflowManifest,
  workflowManifestFingerprint,
  type WorkflowDefinitionIssue,
  type WorkflowDefinitionResult
} from "./definition";
export {
  createWorkflowFolderSource,
  noWorkflowDefinitions,
  workflowDefinitionRefusal,
  type WorkflowDefinitionRevision,
  type WorkflowDefinitionSource,
  type WorkflowDefinitionSummary
} from "./definition-source";
export {
  createWorkflowEngine,
  workflowStepJobKind,
  type StartWorkflowRunInput,
  type WorkflowEngine,
  type WorkflowEngineOptions
} from "./engine";
export * from "./limits";
export { workflowScheduleJobKind } from "./schedule-trigger";
export { secretOperationSteps, type WorkflowOperationCalls } from "./operation-step";
