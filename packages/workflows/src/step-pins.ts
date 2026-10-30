import { sha256Hex } from "@work-shape/catalyst-core/sha256";
import {
  AppError,
  canonicalJson,
  type ClientInstanceId,
  type JsonValue,
  type PlatformStores,
  type WorkflowManifest,
  type WorkflowPinnedStep,
  type WorkflowRun,
  type WorkflowRunId,
  type WorkflowStep,
  type WorkflowStepPin
} from "@work-shape/catalyst-core";
import { holdsDatasetReference, fileReferences } from "./json";
import { WorkflowStepFailure } from "./step-failure";

// Pinned step outputs (EW-10). A person who may write a Workflow pins the output one step had
// in a run of it, and the test runs of the draft they start end that step with that output
// instead of running it: no call, no model run, no script. A pin names its run and holds no
// value, so the output stays that run's data. It is cleared once the draft's step is not the
// one it was pinned on, or its run's output is gone; both are found when the pins are read.

/** The codes a pin is refused with, or a pinned step fails with. */
export const WORKFLOW_PIN_ERRORS = {
  /** The step is no step outside every block, or of a type whose output is never pinned. */
  notPinnable: "pin_step_not_pinnable",
  /** The run's definition of the step is not the draft's. */
  stepChanged: "pin_step_changed",
  /** The run has no output of the step: it did not end `done`, or the run's data was pruned. */
  outputGone: "pin_output_gone",
  /** The output names a dataset or a file, which belong to its run alone. */
  notPortable: "pin_output_not_portable"
} as const;

/** The types of step whose output is pinned: those that call, run a model or run a script. */
const PINNABLE_STEP_TYPES: ReadonlySet<WorkflowStep["type"]> = new Set([
  "operation",
  "agent",
  "code",
  "workflow"
]);

/** A pin as a reader is shown it: the step, the run it came from, and when. */
export interface WorkflowStepPinView {
  step: string;
  runId: WorkflowRunId;
  pinnedAt: string;
}

/** The hash of a step's definition: the same step in two revisions has the same one. */
export function workflowStepHash(step: WorkflowStep): string {
  return sha256Hex(canonicalJson(step as unknown as JsonValue));
}

/** The step of this id outside every block, of a type whose output is pinned. */
function pinnableStep(manifest: WorkflowManifest, id: string): WorkflowStep | undefined {
  const step = manifest.steps.find((candidate) => candidate.id === id);
  return step !== undefined && PINNABLE_STEP_TYPES.has(step.type) ? step : undefined;
}

function refusal(code: string, message: string): AppError {
  return new AppError("CONFLICT", message, { reason: code }, { exposeMessage: true });
}

const toView = (pin: WorkflowStepPin): WorkflowStepPinView => ({
  step: pin.step,
  runId: pin.sourceRunId,
  pinnedAt: pin.pinnedAt
});

export function createWorkflowStepPins(options: {
  clientInstanceId: ClientInstanceId;
  stores: Pick<PlatformStores, "workflowRuns" | "workflowStepPins">;
  now(): Date;
}) {
  const { clientInstanceId, stores } = options;

  /** The output of a step outside every block in a run, where the run still has it. */
  async function sourceOutput(runId: WorkflowRunId, step: string) {
    return stores.workflowRuns.findStepOutput({ clientInstanceId, runId, stepId: step });
  }

  /**
   * One person's pins that hold for the draft as it is now. A pin whose step changed, went or
   * is in a block now, or whose run lost the output, is removed here: it is cleared.
   */
  async function holding(
    assetId: string,
    pinnedBy: string,
    draft: WorkflowManifest
  ): Promise<WorkflowStepPin[]> {
    const pins = await stores.workflowStepPins.list({ clientInstanceId, assetId, pinnedBy });
    const kept: WorkflowStepPin[] = [];
    const cleared: string[] = [];
    for (const pin of pins) {
      const step = pinnableStep(draft, pin.step);
      const holds =
        step !== undefined &&
        workflowStepHash(step) === pin.stepHash &&
        (await sourceOutput(pin.sourceRunId, pin.step)) !== undefined;
      if (holds) kept.push(pin);
      else cleared.push(pin.step);
    }
    if (cleared.length > 0) {
      await stores.workflowStepPins.remove({ clientInstanceId, assetId, pinnedBy, steps: cleared });
    }
    return kept;
  }

  return {
    /** The person's pins on the draft, those that no longer hold cleared first. */
    async list(input: {
      assetId: string;
      pinnedBy: string;
      draft: WorkflowManifest;
    }): Promise<WorkflowStepPinView[]> {
      return (await holding(input.assetId, input.pinnedBy, input.draft)).map(toView);
    },

    /**
     * Pins a step on the output it had in `source`, a run of the same Workflow whose data the
     * caller was let read. Refused where the run's step is not the draft's, where the run has
     * no output of it, and where the output names a dataset or a file of that run.
     */
    async pin(input: {
      assetId: string;
      pinnedBy: string;
      draft: WorkflowManifest;
      step: string;
      source: WorkflowRun;
    }): Promise<WorkflowStepPinView> {
      const { assetId, pinnedBy, draft, step: stepId, source } = input;
      const step = pinnableStep(draft, stepId);
      if (step === undefined) {
        throw refusal(
          WORKFLOW_PIN_ERRORS.notPinnable,
          `The draft has no step '${stepId}' outside every block whose output can be pinned`
        );
      }
      const definition = await stores.workflowRuns.readRunDefinition({
        clientInstanceId,
        id: source.id
      });
      const ran = definition === undefined ? undefined : pinnableStep(definition, stepId);
      if (ran === undefined || workflowStepHash(ran) !== workflowStepHash(step)) {
        throw refusal(
          WORKFLOW_PIN_ERRORS.stepChanged,
          `The step '${stepId}' of the draft is not the one that run ran, so its output is not pinned`
        );
      }
      const output = await sourceOutput(source.id, stepId);
      if (output === undefined) {
        throw refusal(
          WORKFLOW_PIN_ERRORS.outputGone,
          `That run has no output of the step '${stepId}': it did not end done, or the run's data was removed`
        );
      }
      if (holdsDatasetReference(output.value) || (fileReferences(output.value) ?? [1]).length > 0) {
        throw refusal(
          WORKFLOW_PIN_ERRORS.notPortable,
          `The output of the step '${stepId}' names a dataset or a file of that run, which no other run can read`
        );
      }
      const pin: WorkflowStepPin = {
        step: stepId,
        sourceRunId: source.id,
        stepHash: workflowStepHash(step),
        pinnedBy,
        pinnedAt: options.now().toISOString()
      };
      await stores.workflowStepPins.put({ clientInstanceId, assetId, pin });
      return toView(pin);
    },

    /** Removes the person's pin of a step. Answers whether there was one. */
    async unpin(input: { assetId: string; pinnedBy: string; step: string }): Promise<boolean> {
      return (
        (await stores.workflowStepPins.remove({
          clientInstanceId,
          assetId: input.assetId,
          pinnedBy: input.pinnedBy,
          steps: [input.step]
        })) > 0
      );
    },

    /** The pins a test run of the draft its owner starts takes, as the run records them. */
    async forTestRun(input: {
      assetId: string;
      pinnedBy: string;
      draft: WorkflowManifest;
    }): Promise<WorkflowPinnedStep[]> {
      return (await holding(input.assetId, input.pinnedBy, input.draft)).map((pin) => ({
        step: pin.step,
        sourceRunId: pin.sourceRunId
      }));
    }
  };
}

export type WorkflowStepPins = ReturnType<typeof createWorkflowStepPins>;

/**
 * The output a step of a test run ends with where the run took a pin of it: the step outside
 * every block, in a run of the draft. Nothing for every other step run.
 */
export async function pinnedStepOutput(
  stores: Pick<PlatformStores, "workflowRuns">,
  run: WorkflowRun,
  stepRun: { stepId: string; containerStepRunId?: string }
): Promise<{ value: JsonValue } | undefined> {
  if (run.mode !== "test" || stepRun.containerStepRunId !== undefined) return undefined;
  const pinned = run.pinnedSteps?.find((entry) => entry.step === stepRun.stepId);
  if (pinned === undefined) return undefined;
  const output = await stores.workflowRuns.findStepOutput({
    clientInstanceId: run.clientInstanceId,
    runId: pinned.sourceRunId,
    stepId: pinned.step
  });
  if (output === undefined) {
    throw new WorkflowStepFailure(
      WORKFLOW_PIN_ERRORS.outputGone,
      `The pinned output of the step '${pinned.step}' is gone: its run's data was removed`
    );
  }
  return output;
}
