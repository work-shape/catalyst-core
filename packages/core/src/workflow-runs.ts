import type { ClientInstanceId, OperationRunId, WorkflowRunId, WorkflowStepRunId } from "./ids";
import type { JsonObject, JsonValue } from "./json";
import type { WorkflowRunPrincipal } from "./identity";
import type { OperationRunActor } from "./operation-runs";
import type { StorePage } from "./paging";
import type { ISODateString } from "./time";
import type {
  WorkflowLoopCounts,
  WorkflowManifest,
  WorkflowRunMode,
  WorkflowRunStatus,
  WorkflowStepRunStatus,
  WorkflowStepType,
  WorkflowTriggerKind
} from "./workflows";

// A Workflow Run and its step runs as they are stored and read. The names a definition and a
// call carry are in `workflows.ts`; the engine is in `@vivd-catalyst/workflows`.

/**
 * How many characters of a run's result or of a step's output a read shows. The whole value
 * stays in the store; a longer one is cut here and marked as cut.
 */
export const WORKFLOW_OUTPUT_PREVIEW_MAX_CHARS = 2_000;

/** The statuses a run or a step run does not leave. */
export const WORKFLOW_ENDED_STATUSES = ["done", "failed", "cancelled", "limit_reached"] as const;

export function isWorkflowRunEnded(status: WorkflowRunStatus): boolean {
  return WORKFLOW_ENDED_STATUSES.some((ended) => ended === status);
}

/**
 * Why a run or a step run did not end as `done`: a code of the engine and a sentence that may
 * be shown. Never a value of an input or an output, and never text of an outside system.
 */
export interface WorkflowRunError {
  code: string;
  message: string;
  /** On a run: the step run it ended at. */
  stepRunId?: WorkflowStepRunId;
}

/** A run without the values it carries, as the engine holds it while it works. */
export interface WorkflowRun {
  id: WorkflowRunId;
  clientInstanceId: ClientInstanceId;
  /** The id of the Workflow. */
  workflow: string;
  /** The fingerprint of the definition the run executes. */
  revision: string;
  mode: WorkflowRunMode;
  trigger: WorkflowTriggerKind;
  status: WorkflowRunStatus;
  /** The definition as it stood when the run started. A run never reads a newer one. */
  definition: WorkflowManifest;
  /**
   * The service principal the run acts as: the id every step reads the principal by, and the
   * label it had when the run started. The actor of a step's call is the whole principal.
   */
  principal: Pick<WorkflowRunPrincipal, "id" | "displayLabel">;
  /** Who started the run. Its rights opened the start and nothing a step does. */
  startedBy: OperationRunActor;
  /** The Operation Run of the call that started the run. */
  operationRunId?: OperationRunId;
  /** Step runs created so far, the steps of every loop iteration among them. */
  stepRunCount: number;
  /** After this moment no further step starts and the run ends as `limit_reached`. */
  deadlineAt: ISODateString;
  error?: WorkflowRunError;
  correlationId: string;
  createdAt: ISODateString;
  startedAt?: ISODateString;
  finishedAt?: ISODateString;
}

export type NewWorkflowRun = Pick<
  WorkflowRun,
  | "id"
  | "clientInstanceId"
  | "workflow"
  | "revision"
  | "mode"
  | "trigger"
  | "definition"
  | "principal"
  | "startedBy"
  | "operationRunId"
  | "deadlineAt"
  | "correlationId"
  | "createdAt"
> & {
  /** The run's input, checked against the definition's `inputs`. */
  input: JsonObject;
};

/** A value cut to `WORKFLOW_OUTPUT_PREVIEW_MAX_CHARS` characters of its JSON. */
export interface WorkflowOutputPreview {
  text: string;
  truncated: boolean;
}

/** A run as a read shows it: no definition and no input, and the result as a preview. */
export type WorkflowRunView = Omit<WorkflowRun, "definition"> & {
  outputPreview?: WorkflowOutputPreview;
};

/** A step run without the values it carries. */
export interface WorkflowStepRun {
  id: WorkflowStepRunId;
  clientInstanceId: ClientInstanceId;
  runId: WorkflowRunId;
  /** The id of the step in the definition. */
  stepId: string;
  stepType: WorkflowStepType;
  /**
   * The step's place in the run: its id, and inside a loop the loop's key, the number of the
   * item and the id, as in `each_client[3].bookings`. One step run exists per key of a run.
   */
  key: string;
  /** The step run of the loop this one is an iteration step of. */
  parentStepRunId?: WorkflowStepRunId;
  /** Which item of that loop, from 0. */
  iteration?: number;
  /** What the loop's `itemLabel` field holds for that item, for a person to tell it by. */
  iterationLabel?: string;
  status: WorkflowStepRunStatus;
  /** The number of the job attempt that last executed the step, from 1. */
  attempt: number;
  operationRunId?: OperationRunId;
  error?: WorkflowRunError;
  createdAt: ISODateString;
  startedAt?: ISODateString;
  finishedAt?: ISODateString;
}

export type NewWorkflowStepRun = Pick<
  WorkflowStepRun,
  | "id"
  | "clientInstanceId"
  | "runId"
  | "stepId"
  | "stepType"
  | "key"
  | "parentStepRunId"
  | "iteration"
  | "iterationLabel"
  | "createdAt"
>;

/** A step run as a read shows it: its output as a preview, and of a loop how far it is. */
export type WorkflowStepRunView = WorkflowStepRun & {
  outputPreview?: WorkflowOutputPreview;
  /** On the step run of a loop step alone. */
  loop?: WorkflowLoopCounts;
};

/** Names one run of one instance. */
export interface WorkflowRunRef {
  clientInstanceId: ClientInstanceId;
  id: WorkflowRunId;
}

/** Names one step run of one instance. `id` is whatever a job or a caller named. */
export interface WorkflowStepRunRef {
  clientInstanceId: ClientInstanceId;
  id: string;
}

/** How a step run ended. The input of a step is not kept: the steps before it hold it. */
export interface WorkflowStepRunEnd {
  status: Exclude<WorkflowStepRunStatus, "queued" | "running" | "waiting">;
  finishedAt: ISODateString;
  output?: JsonValue;
  operationRunId?: OperationRunId;
  error?: WorkflowRunError;
}

export interface WorkflowRunsStore {
  /** Writes a run as `queued`. */
  createRun(run: NewWorkflowRun): Promise<WorkflowRun>;
  /**
   * Reads a run and holds its row until the transaction ends. Every write to a run or to one
   * of its step runs is made behind it, so a step that ends and a cancel never both win.
   */
  lockRun(ref: WorkflowRunRef): Promise<WorkflowRun | undefined>;
  /** `id` is whatever a caller named: an id no run has answers `undefined`. */
  readRun(input: {
    clientInstanceId: ClientInstanceId;
    id: string;
  }): Promise<WorkflowRunView | undefined>;
  /** The runs of one Workflow, newest first, by creation time and id. */
  listRuns(input: {
    clientInstanceId: ClientInstanceId;
    workflow: string;
    page?: StorePage;
  }): Promise<WorkflowRunView[]>;
  /** The run's input, as the trigger step hands it on. */
  readRunInput(ref: WorkflowRunRef): Promise<JsonObject | undefined>;
  /** Moves a `queued` run to `running`. A run in another status is left as it is. */
  markRunRunning(ref: WorkflowRunRef & { startedAt: ISODateString }): Promise<void>;
  /** Ends a run that has not ended. Answers whether this call ended it. */
  endRun(
    ref: WorkflowRunRef & {
      status: (typeof WORKFLOW_ENDED_STATUSES)[number];
      finishedAt: ISODateString;
      output?: JsonValue;
      error?: WorkflowRunError;
    }
  ): Promise<boolean>;
  /** Writes a step run as `queued` and counts it on its run. */
  createStepRun(stepRun: NewWorkflowStepRun): Promise<WorkflowStepRun>;
  getStepRun(ref: WorkflowStepRunRef): Promise<WorkflowStepRun | undefined>;
  /** Moves a step run that has not ended to `running` under the number of the attempt. */
  markStepRunRunning(
    ref: WorkflowStepRunRef & { attempt: number; startedAt: ISODateString }
  ): Promise<void>;
  /** Ends a step run that has not ended. Answers whether this call ended it. */
  endStepRun(ref: WorkflowStepRunRef & WorkflowStepRunEnd): Promise<boolean>;
  /**
   * Moves a running loop step run to `waiting` and keeps the list it runs over. From then on
   * the step runs of its items carry the loop on, and its own job has nothing left to do.
   */
  markLoopWaiting(ref: WorkflowStepRunRef & { items: readonly JsonValue[] }): Promise<void>;
  /** The step runs of a run that have not ended. */
  listOpenStepRuns(ref: WorkflowRunRef): Promise<WorkflowStepRun[]>;
  /** The step runs of one run in the order they were created. */
  listStepRuns(input: {
    clientInstanceId: ClientInstanceId;
    runId: WorkflowRunId;
    page?: StorePage;
  }): Promise<WorkflowStepRunView[]>;
  /**
   * The output of the step run of `stepId` that ended as `done` in one place of the run: at
   * the top where `parentStepRunId` is missing, otherwise in that iteration of that loop.
   */
  findStepOutput(input: {
    clientInstanceId: ClientInstanceId;
    runId: WorkflowRunId;
    stepId: string;
    parentStepRunId?: WorkflowStepRunId;
    iteration?: number;
  }): Promise<{ value: JsonValue } | undefined>;
  /** How many items the list of a loop step run holds, once the loop resolved it. */
  countLoopItems(ref: WorkflowStepRunRef): Promise<number | undefined>;
  /** One item of the list of a loop step run, without reading the list. */
  readLoopItem(
    ref: WorkflowStepRunRef & { index: number }
  ): Promise<{ value: JsonValue } | undefined>;
  /** How many bytes the outputs of the step runs of `stepId` in a loop hold together, as JSON. */
  measureLoopResults(ref: WorkflowStepRunRef & { stepId: string }): Promise<number>;
  /** The outputs of the step runs of `stepId` in a loop, in the order of its items. */
  listLoopResults(ref: WorkflowStepRunRef & { stepId: string }): Promise<JsonValue[]>;
}
