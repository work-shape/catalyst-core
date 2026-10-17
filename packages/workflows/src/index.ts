import { workflowDeadlineJobKind } from "./run-deadline";
import {
  WORKFLOW_ASSET_KIND,
  WORKFLOW_RUN_JOB_KINDS,
  defineModule
} from "@work-shape/catalyst-core";
import { WORKFLOW_CODE_JOB_KIND, WORKFLOW_CODE_SWEEP_JOB_KIND } from "./step-job";
import { WORKFLOW_TEST_TOOL_NAMES } from "@work-shape/catalyst-tool-execution";

/** The operations of the API that belong to the module. Each is off where the module is. */
export const WORKFLOW_OPERATION_IDS = [
  "workflows.list",
  "workflows.start",
  "workflows.test",
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
  tools: WORKFLOW_TEST_TOOL_NAMES,
  kinds: [WORKFLOW_ASSET_KIND],
  jobKinds: [
    WORKFLOW_RUN_JOB_KINDS.executeStep,
    workflowDeadlineJobKind.kind,
    WORKFLOW_RUN_JOB_KINDS.fireSchedule,
    WORKFLOW_CODE_JOB_KIND,
    WORKFLOW_CODE_SWEEP_JOB_KIND,
    WORKFLOW_RUN_JOB_KINDS.pruneData,
    WORKFLOW_RUN_JOB_KINDS.deleteDatasets
  ],
  // The scripts of code steps run in the sandbox, which the command worker alone reaches.
  commandWorkerJobKinds: [WORKFLOW_CODE_JOB_KIND, WORKFLOW_CODE_SWEEP_JOB_KIND]
});

export { createCodeStepJobs, type CodeStepJobs, type CodeStepJobsOptions } from "./code-job";
export {
  assertWorkflowPackages,
  runnerPackageKey,
  type WorkflowRunnerPackage
} from "./runner-packages";
export { createCodeSandbox } from "./code-sandbox";
export {
  WORKFLOW_CODE_ERRORS,
  WORKFLOW_CODE_FILE_MAX_BYTES,
  WORKFLOW_CODE_LANGUAGES,
  WORKFLOW_CODE_LOG_MAX_BYTES,
  WORKFLOW_CODE_STEP_EFFECT,
  WORKFLOW_STEP_FILES_MAX_BYTES,
  codeStepIssues,
  noWorkflowStepFiles,
  stepFileBytes,
  workflowStepFileIssues,
  workflowStepFilesRefusal,
  type WorkflowStepFile,
  type WorkflowStepFileIssue,
  type WorkflowStepFiles
} from "./code-step";
export {
  WORKFLOW_CODE_JOB_KIND,
  WORKFLOW_CODE_SWEEP_JOB_KIND,
  workflowCodeJobKind
} from "./step-job";
export type { WorkflowCodeRunner } from "./step-execution";

export {
  WORKFLOW_AUTHORING_EXAMPLES,
  WORKFLOW_AUTHORING_SKILL_NAME,
  workflowAuthoringSkill,
  createWorkflowAuthoringSkill,
  workflowStepTypesNotRun
} from "./authoring-skill";
export { lastDueWithin, nextDueAfter, parseCron } from "./cron";
export {
  WORKFLOW_EXECUTED_STEP_TYPES,
  WORKFLOW_LIMIT_ABOVE_CEILING,
  indexWorkflowSteps,
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
  type TestWorkflowRunInput,
  type WorkflowEngine,
  type WorkflowEngineOptions
} from "./engine";
export { workflowStepJobKind } from "./step-job";
export { WORKFLOW_TEST_RUN_ERRORS } from "./test-run";
export * from "./limits";
export {
  workflowDurationText,
  workflowLimitIssues,
  workflowLimitRaises,
  workflowRunBounds,
  type WorkflowLimitContext
} from "./run-limits";
export { replaceScheduleJob, workflowScheduleJobKind } from "./schedule-trigger";
export { secretOperationSteps, type WorkflowOperationCalls } from "./operation-step";
export { checkChildContracts, checkChildCycles } from "./child-contracts";
export { workflowRunPrincipal } from "./run-identity";
export {
  workflowDefinitionStartIssues,
  workflowStartIssues,
  type WorkflowStartIssue
} from "./start-checks";
export { createWorkflowDatasets } from "./datasets";
export type { WorkflowDatasets, WorkflowDatasetsOptions } from "./datasets";

export { checkDatasetContracts } from "./dataset-contracts";

export { enqueueDatasetCleanup } from "./dataset-lifetime";
