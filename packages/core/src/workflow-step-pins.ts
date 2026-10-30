import type { ClientInstanceId, WorkflowRunId } from "./ids";
import type { ISODateString } from "./time";

// Pinned step outputs (EW-10). A person who may write a Workflow pins the output one step had
// in a run of it; their own later test runs of the draft end that step with the output instead
// of running it. A pin holds no value: it names the run, whose data it stays, with that run's
// retention and readers. It belongs to the draft and its owner, one per step, and is cleared
// once the draft's step is no longer the one it was pinned on.

/** One pin: the step, the run whose output of it is used, and the step it was pinned on. */
export interface WorkflowStepPin {
  /** The id of the step, outside every block. */
  step: string;
  /** The run of the same Workflow whose output of the step a test run uses. */
  sourceRunId: WorkflowRunId;
  /** The hash of the step's definition it was pinned on. Another one clears the pin. */
  stepHash: string;
  /** The owner: only the test runs they start use it. */
  pinnedBy: string;
  pinnedAt: ISODateString;
}

export interface WorkflowStepPinsStore {
  /** Sets the pin, in place of one its owner had on the same step. */
  put(input: {
    clientInstanceId: ClientInstanceId;
    /** The asset of the Workflow: its pins go with it. */
    assetId: string;
    pin: WorkflowStepPin;
  }): Promise<void>;
  /** One person's pins on the Workflow, whatever their step is now. */
  list(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
    pinnedBy: string;
  }): Promise<WorkflowStepPin[]>;
  /** Removes the person's pins of these steps. Answers how many there were. */
  remove(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
    pinnedBy: string;
    steps: readonly string[];
  }): Promise<number>;
}
