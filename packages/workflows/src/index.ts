import { WORKFLOW_RUN_JOB_KINDS, defineModule } from "@vivd-catalyst/core";

/** The operations of the API that belong to the module. Each is off where the module is. */
export const WORKFLOW_OPERATION_IDS = [
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
  jobKinds: [WORKFLOW_RUN_JOB_KINDS.executeStep]
});

export {
  WORKFLOW_EXECUTED_STEP_TYPES,
  parseWorkflowManifest,
  readWorkflowManifest,
  type WorkflowDefinitionIssue,
  type WorkflowDefinitionResult
} from "./definition";
export {
  createWorkflowFolderSource,
  noWorkflowDefinitions,
  type WorkflowDefinitionSource
} from "./definition-source";
export {
  createWorkflowEngine,
  workflowStepJobKind,
  type StartWorkflowRunInput,
  type WorkflowEngine,
  type WorkflowEngineOptions
} from "./engine";
export * from "./limits";
export type { WorkflowOperationCalls } from "./operation-step";
