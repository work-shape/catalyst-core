import { WORKFLOW_ASSET_KIND, WORKFLOW_RUN_JOB_KINDS, defineModule } from "@vivd-catalyst/core";
import { WORKFLOW_CODE_JOB_KIND, WORKFLOW_CODE_SWEEP_JOB_KIND } from "./step-job";

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
 * Workflows: their asset kind, their runs and the engine that executes their steps on the job
 * executor. Where the module is off, the kind is not registered, no run is started, read or
 * cancelled and no step job is served.
 */
export const workflowsModule = defineModule({
  name: "workflows",
  operations: WORKFLOW_OPERATION_IDS,
  kinds: [WORKFLOW_ASSET_KIND],
  jobKinds: [
    WORKFLOW_RUN_JOB_KINDS.executeStep,
    WORKFLOW_RUN_JOB_KINDS.fireSchedule,
    WORKFLOW_CODE_JOB_KIND,
    WORKFLOW_CODE_SWEEP_JOB_KIND
  ],
  // The scripts of code steps run in the sandbox, which the command worker alone reaches.
  commandWorkerJobKinds: [WORKFLOW_CODE_JOB_KIND, WORKFLOW_CODE_SWEEP_JOB_KIND]
});

export { createCodeStepJobs, type CodeStepJobs, type CodeStepJobsOptions } from "./code-job";
export { createCodeSandbox } from "./code-sandbox";
export {
  WORKFLOW_CODE_ERRORS,
  WORKFLOW_CODE_FILE_MAX_BYTES,
  WORKFLOW_CODE_LANGUAGES,
  WORKFLOW_CODE_LOG_MAX_BYTES,
  WORKFLOW_CODE_STEP_EFFECT,
  codeStepIssues,
  noWorkflowStepFiles,
  type WorkflowStepFiles
} from "./code-step";
export {
  WORKFLOW_CODE_JOB_KIND,
  WORKFLOW_CODE_SWEEP_JOB_KIND,
  workflowCodeJobKind
} from "./step-job";
export type { WorkflowCodeRunner } from "./step-execution";

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
  type StartWorkflowRunInput,
  type WorkflowEngine,
  type WorkflowEngineOptions
} from "./engine";
export { workflowStepJobKind } from "./step-job";
export * from "./limits";
export { replaceScheduleJob, workflowScheduleJobKind } from "./schedule-trigger";
export { secretOperationSteps, type WorkflowOperationCalls } from "./operation-step";
export {
  workflowDefinitionStartIssues,
  workflowStartIssues,
  type WorkflowStartIssue
} from "./start-checks";
