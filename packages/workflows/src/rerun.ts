import {
  AppError,
  type ClientInstanceId,
  type PlatformStores,
  type WorkflowManifest,
  type WorkflowRun,
  type WorkflowRunRerun
} from "@work-shape/catalyst-core";
import { portableOutput, workflowStepHash } from "./step-pins";

// Re-running a run from a chosen step (EW-11). The new run is a run of the Workflow's revision
// now (the published one, or the draft for a test run) with the original's input. The steps
// outside every block before the chosen one end with the original's outputs, by the reuse of
// `pinnedStepOutput`, and the chosen step and those after it run. A step before the chosen one
// that is not the step the original ran, or whose output the original does not have or cannot
// hand on, makes every later step no place to re-run from.

/** The codes a re-run is refused with. */
export const WORKFLOW_RERUN_ERRORS = {
  /** The run has not ended `done` or `failed`, has a parent, or is one of several histories. */
  notSupported: "rerun_not_supported",
  /** The step is the trigger, a step inside a block, or no step of the revision. */
  stepNotOffered: "rerun_step_not_offered",
  /** A step before the chosen one is not the step the original ran. */
  stepChanged: "rerun_step_changed",
  /** The original has no output of a step before the chosen one, or its data was removed. */
  outputGone: "rerun_output_gone",
  /** The original's output of a step before the chosen one names a dataset or a file of it. */
  notPortable: "rerun_output_not_portable"
} as const;

type RerunRefusalCode = (typeof WORKFLOW_RERUN_ERRORS)[keyof typeof WORKFLOW_RERUN_ERRORS];

/** One step outside every block, as a re-run of a run would treat it. */
export interface WorkflowRerunStep {
  step: string;
  /** The revision's step is not the one the original ran, or the original had no such step. */
  changed: boolean;
  /** Why the run cannot be re-run from this step, and the step that is why. Missing where it can. */
  refusal?: { code: RerunRefusalCode; step?: string };
}

const MESSAGES: Record<RerunRefusalCode, (step: string | undefined) => string> = {
  rerun_not_supported: () =>
    "Only a run that ended done or failed, has no parent and is a single history is re-run from a step",
  rerun_step_not_offered: (step) =>
    `The run is not re-run from '${step ?? "?"}': it is the trigger, a step inside a block, or no step of the Workflow`,
  rerun_step_changed: (step) =>
    `The step '${step ?? "?"}' changed since the run, so its output is not reused: re-run from that step`,
  rerun_output_gone: (step) =>
    step === undefined
      ? "The run's data was removed, so it is not re-run"
      : `The run has no output of the step '${step}': it did not get there, or its data was removed`,
  rerun_output_not_portable: (step) =>
    `The output of the step '${step ?? "?"}' names a dataset or a file of the run, which no other run can read`
};

/** The refusal of a re-run, with the code and the step that is why. */
export function workflowRerunRefusal(code: RerunRefusalCode, step?: string): AppError {
  return new AppError(
    code === WORKFLOW_RERUN_ERRORS.stepNotOffered ? "VALIDATION_FAILED" : "CONFLICT",
    MESSAGES[code](step),
    { reason: code, ...(step === undefined ? {} : { step }) },
    { exposeMessage: true }
  );
}

/**
 * For each step outside every block of `manifest`, whether `original` can be re-run from it on
 * that revision, and whether the step changed since the original ran.
 */
export async function workflowRerunSteps(
  options: {
    clientInstanceId: ClientInstanceId;
    stores: {
      workflowRuns: Pick<PlatformStores["workflowRuns"], "findStepOutput" | "readRunDefinition">;
    };
  },
  original: Pick<WorkflowRun, "id" | "status" | "parentRunId" | "continuation" | "dataPrunedAt">,
  manifest: WorkflowManifest
): Promise<WorkflowRerunStep[]> {
  const { clientInstanceId, stores } = options;
  const ran = await stores.workflowRuns.readRunDefinition({ clientInstanceId, id: original.id });
  const ranSteps = new Map((ran?.steps ?? []).map((step) => [step.id, step]));
  const supported =
    (original.status === "done" || original.status === "failed") &&
    original.parentRunId === undefined &&
    original.continuation === undefined;
  let blocked: WorkflowRerunStep["refusal"] = !supported
    ? { code: WORKFLOW_RERUN_ERRORS.notSupported }
    : original.dataPrunedAt !== undefined
      ? { code: WORKFLOW_RERUN_ERRORS.outputGone }
      : undefined;
  const steps: WorkflowRerunStep[] = [];
  for (const [position, step] of manifest.steps.entries()) {
    const before = ranSteps.get(step.id);
    const changed = before === undefined || workflowStepHash(before) !== workflowStepHash(step);
    // The trigger runs again on the original's input: it is no step to re-run from or reuse.
    const trigger = position === 0;
    const refusal = trigger ? { code: WORKFLOW_RERUN_ERRORS.stepNotOffered } : blocked;
    steps.push({ step: step.id, changed, ...(refusal ? { refusal } : {}) });
    if (trigger || blocked) continue;
    // From the next step on, this one is reused.
    if (changed) {
      blocked = { code: WORKFLOW_RERUN_ERRORS.stepChanged, step: step.id };
      continue;
    }
    const output = await stores.workflowRuns.findStepOutput({
      clientInstanceId,
      runId: original.id,
      stepId: step.id
    });
    if (output === undefined) blocked = { code: WORKFLOW_RERUN_ERRORS.outputGone, step: step.id };
    else if (!portableOutput(output.value))
      blocked = { code: WORKFLOW_RERUN_ERRORS.notPortable, step: step.id };
  }
  return steps;
}

/**
 * What the new run names of the original where it can be re-run from `fromStep`, or the
 * refusal of the re-run.
 */
export function workflowRerunOf(
  original: Pick<WorkflowRun, "id">,
  steps: readonly WorkflowRerunStep[],
  fromStep: string
): WorkflowRunRerun {
  const at = steps.findIndex((step) => step.step === fromStep);
  const chosen = steps[at];
  if (chosen === undefined)
    throw workflowRerunRefusal(WORKFLOW_RERUN_ERRORS.stepNotOffered, fromStep);
  if (chosen.refusal)
    throw workflowRerunRefusal(chosen.refusal.code, chosen.refusal.step ?? fromStep);
  return {
    runId: original.id,
    fromStep,
    // The trigger runs again; every step between it and the chosen one is reused.
    reusedSteps: steps.slice(1, at).map((step) => step.step)
  };
}
