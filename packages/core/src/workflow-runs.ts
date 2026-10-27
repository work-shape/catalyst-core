import type { WorkflowDatasetReference } from "./workflows";
import type { WorkflowRunDataset } from "./workflow-datasets";
import {
  WORKFLOW_ENDED_STATUSES,
  type WorkflowTestRevision
} from "@work-shape/catalyst-asset-schemas";
import type { ServicePrincipalRecord } from "./api-access";
import type { ClientInstanceId, OperationRunId, WorkflowRunId, WorkflowStepRunId } from "./ids";
import type { JsonObject, JsonValue } from "./json";
import type { OperationRunActor } from "./operation-runs";
import type { StorePage } from "./paging";
import type { ISODateString } from "./time";
import type { WorkflowBlockStepRunView } from "./workflow-blocks";
import type {
  WorkflowLastRun,
  WorkflowLoopCounts,
  WorkflowManifest,
  WorkflowRunMode,
  WorkflowRunIdentity,
  WorkflowRunLineage,
  WorkflowRunRecordView,
  WorkflowRunStatus,
  WorkflowStep,
  WorkflowStepRunCall,
  WorkflowStepRunFilter,
  WorkflowStepRunLink,
  WorkflowStepRunPlacement,
  WorkflowStepRunStatus,
  WorkflowTriggerKind
} from "./workflows";

// A Workflow Run and its step runs as they are stored and read. The names a definition and a
// call carry are in `workflows.ts`; the engine is in `@work-shape/catalyst-workflows`.

/** The UTF-8 byte ceiling of one inline step value; larger values fail the step. */
export const WORKFLOW_STEP_DATA_MAX_BYTES = 256 * 1_024;

/**
 * How many characters of a run's result or of a step's input or output a read shows. A result
 * and an output stay whole in the store and are cut on read; a step's input is kept only as
 * this cut preview (`workflowValuePreview`).
 */
export const WORKFLOW_OUTPUT_PREVIEW_MAX_CHARS = 2_000;

/** The statuses a run or a step run does not leave. */
export { WORKFLOW_ENDED_STATUSES } from "@work-shape/catalyst-asset-schemas";

/**
 * The ends of a run that give its run key up: a start with the key after one of them is a new
 * run. A run that is open or `done` holds its key (`workflow_runs_active_run_key_idx`).
 */
export const WORKFLOW_KEY_RELEASING_STATUSES = [
  "failed",
  "cancelled",
  "limit_reached",
  "continued"
] as const satisfies readonly WorkflowRunStatus[];

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
  /** Where the run's principal was refused for a right it does not hold: that right. */
  action?: string;
  /** The Connection of a refused connection.use call, as the step recorded it. */
  connection?: string;
  /** On `confirmation_unattended`: the operation an agent step called that needed one. */
  operation?: string;
  /** On a run: the step run it ended at. */
  stepRunId?: WorkflowStepRunId;
}

/**
 * A run without the values it carries, as the engine holds it while it works. Of
 * `WorkflowRunRecordView` it has the revision it started on, and who cancelled it and when:
 * `cancelledBy` is there where a person did, and `cancelledAt` whoever did.
 */
export interface WorkflowRun
  extends WorkflowRunRecordView, WorkflowRunLineage, WorkflowRunIdentity {
  id: WorkflowRunId;
  clientInstanceId: ClientInstanceId;
  /** The id of the Workflow. */
  workflow: string;
  mode: WorkflowRunMode;
  trigger: WorkflowTriggerKind;
  status: WorkflowRunStatus;
  /**
   * The service principal the run acts as: the name its definition gives under `runAs`, which
   * every step reads the principal by, and the id and label it had when the run started. The
   * actor of a step's call is the whole principal, as it is stored when the step runs.
   */
  principal: Pick<ServicePrincipalRecord, "id" | "name" | "displayLabel">;
  /**
   * Who started the run. Its rights opened the start and nothing a step does. A run a
   * schedule started has no person behind it: its `trigger` says `schedule`, and this names
   * the Workflow's own principal, which the due time started the run as.
   */
  startedBy: OperationRunActor;
  /**
   * The due time of the schedule that started the run. One run of a Workflow exists per due
   * time, however often that time is fired. Missing on every other run.
   */
  scheduledFor?: ISODateString;
  /** The Operation Run of the call that started the run. */
  operationRunId?: OperationRunId;
  /**
   * Where a test run was started from besides a person's own start: the action of an App's
   * draft whose click started it (DP-1). Names only, no value. Missing on every other run.
   */
  startedFrom?: WorkflowRunStartedFrom;
  /** Step runs created so far, the steps of every loop iteration among them. */
  stepRunCount: number;
  /**
   * After this moment no further step starts and the run ends as `limit_reached`. It moves
   * later by every stretch the run spent waiting, so it counts running time only.
   */
  deadlineAt: ISODateString;
  /** The bounds the run was opened under. */
  limits: WorkflowRunBounds;
  /**
   * Since when every open step of the run waits for something outside it: an asynchronous
   * operation, or a child run that waits as well. Missing while a step of the run works.
   */
  waitingSince?: ISODateString;
  /** The milliseconds the run has spent waiting so far, which count toward no limit. */
  waitedMs: number;
  error?: WorkflowRunError;
  correlationId: string;
  createdAt: ISODateString;
  startedAt?: ISODateString;
  finishedAt?: ISODateString;
  /**
   * When the values of the run were removed: its input and result, and the inputs and outputs
   * of its step runs. The run and its step runs stay as they were otherwise. Missing while
   * the run still has its values.
   */
  dataPrunedAt?: ISODateString;
}

/**
 * The draft of an App whose `workflow` action started a test run: the App, its revision, the
 * action, and which revision of the Workflow the tester's rights chose.
 */
export interface WorkflowRunStartedFrom {
  kind: "app";
  app: string;
  appRevisionId: string;
  action: string;
  /** The Workflow's draft for a tester who may write it, else its published revision. */
  workflowRevision: WorkflowTestRevision;
}

/**
 * The bounds of one run: its Workflow's `limits` within the operator's ceilings, the
 * release's defaults for what the Workflow leaves out. A child run takes the concurrency of
 * its root, so the runs of one Workflow and their descendants share its slots.
 */
export interface WorkflowRunBounds {
  durationMs: number;
  stepRuns: number;
  loopItems: number;
  /**
   * How many step jobs the runs of the root Workflow and their children run at once, counted
   * by `key`. Missing on a run an earlier release opened, which no such bound holds.
   */
  concurrency?: { key: string; slots: number };
}

export type NewWorkflowRun = Pick<
  WorkflowRun,
  | "id"
  | "clientInstanceId"
  | "workflow"
  | "definitionRevisionId"
  | "mode"
  | "trigger"
  | "principal"
  | "startedBy"
  | "scheduledFor"
  | "operationRunId"
  | "startedFrom"
  | "runKey"
  | "labels"
  | "continuation"
  | "deadlineAt"
  | "limits"
  | "correlationId"
  | "createdAt"
> &
  Partial<WorkflowRunLineage> & {
    /**
     * The definition as it stood when the run started. The run keeps it and never reads a newer
     * one; a step reads it with `readRunDefinition`, and no other read of a run carries it.
     */
    definition: WorkflowManifest;
    /** The run's input, checked against the definition's `inputs`. */
    input: JsonObject;
    /** Engine-owned checkpoint; values are read separately and never in run/list responses. */
    checkpoint?: {
      stepId: string;
      offset: number;
      /** Remaining items; omitted for cursor continuations that read the next page. */
      items?: JsonValue[] | WorkflowDatasetReference;
      /** Totals of finished items in earlier histories, excluding the saved frontier. */
      counts?: { total: number; done: number; failed: number };
      completed?: Record<string, JsonValue>;
      ancestors?: {
        stepId: string;
        offset: number;
        items?: JsonValue[] | WorkflowDatasetReference;
        counts?: { total: number; done: number; failed: number };
        completed?: Record<string, JsonValue>;
      }[];
    };
  };

/** A value cut to `WORKFLOW_OUTPUT_PREVIEW_MAX_CHARS` characters of its JSON. */
export interface WorkflowOutputPreview {
  text: string;
  truncated: boolean;
}

/**
 * A value as JSON text, cut at `WORKFLOW_OUTPUT_PREVIEW_MAX_CHARS` and marked where cut. The cut
 * never splits a surrogate pair: a lone half is no text Postgres stores.
 */
export function workflowValuePreview(value: JsonValue): WorkflowOutputPreview {
  const text = JSON.stringify(value);
  if (text.length <= WORKFLOW_OUTPUT_PREVIEW_MAX_CHARS) return { text, truncated: false };
  const cut = text.slice(0, WORKFLOW_OUTPUT_PREVIEW_MAX_CHARS);
  return { text: /[\uD800-\uDBFF]$/u.test(cut) ? cut.slice(0, -1) : cut, truncated: true };
}

/** A run as a read shows it: no definition and no input, and the result as a preview. */
export type WorkflowRunView = WorkflowRun & {
  /** Internal projection policy from the pinned definition; never serialized by the API. */
  hasAgentSteps?: boolean;
  /** Descendants that failed, reached a limit or contain failed items, excluding this run. */
  failedDescendantCount?: number;
  outputPreview?: WorkflowOutputPreview;
  datasets?: Pick<WorkflowRunDataset, "id" | "rowSchema" | "rowCount" | "bytes" | "state">[];
};

/**
 * A step run without the values it carries. Where it stands in the tree of its run is
 * `WorkflowStepRunPlacement`: the step run of the loop around it and the item of that loop.
 * `branch` is there once an engine runs a block that has branches. On the step run of an
 * operation step, `effect` and `source` say what was called, once the operation is known.
 */
export interface WorkflowStepRun
  extends WorkflowStepRunPlacement, WorkflowStepRunCall, WorkflowStepRunLink {
  id: WorkflowStepRunId;
  clientInstanceId: ClientInstanceId;
  runId: WorkflowRunId;
  /** The id of the step in the definition. */
  stepId: string;
  /** The type the definition gives the step, a reserved one included. */
  stepType: WorkflowStep["type"];
  /**
   * The path of the step in the run: its id, and inside a loop the loop's path, the number of
   * the item and the id, as in `each_client[3].bookings`. One step run exists per path of a
   * run. It is what a run is taken up again by: a path that has a step run is never started
   * a second time, whichever worker asks.
   */
  key: string;
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
  | "containerStepRunId"
  | "branch"
  | "iteration"
  | "createdAt"
>;

/**
 * A step run as a read shows it: its input and output as previews, and of a loop how far its items are
 * (`loop`) and how the step runs of each step directly inside it stand (`bodyCounts`).
 */
export type WorkflowStepRunView = WorkflowStepRun &
  WorkflowBlockStepRunView & {
    /** The child run this step owns, resolved when reading; distinct from a reused keyed run. */
    childRunId?: WorkflowRunId;
    inputPreview?: WorkflowOutputPreview;
    agent?: import("./child-agent-runs").WorkflowAgentRunData;
    outputPreview?: WorkflowOutputPreview;
    /**
     * Internal projection policy, never serialized by the API: the step sends mail
     * (`mail.send`), so a preview of the mail it would send is the run's data.
     */
    sendsMail?: boolean;
    datasets?: Pick<WorkflowRunDataset, "id" | "rowSchema" | "rowCount" | "bytes" | "state">[];
    /** On the step run of a loop step alone. */
    loop?: WorkflowLoopCounts;
    /** On the step run of a loop step alone. */
    concurrency?: WorkflowLoopConcurrency;
    /** On the step run of a code step that ran: what its script wrote beside its result. */
    log?: WorkflowStepRunLog;
  };

/**
 * What the script of a code step wrote to its output and error streams, each cut to a bound.
 * It is shown on the run page to whoever may read the run, and it is never written to the
 * audit: a script prints what its author made it print.
 */
export interface WorkflowStepRunLog {
  stdout: string;
  stderr: string;
  /** Whether either stream held more than was kept. */
  truncated: boolean;
}

/**
 * A code step as it waits for the sandbox: its revision tree reference and mapped input. The step run keeps it from the moment the engine hands the step to the
 * command worker until the script has ended.
 */
export interface WorkflowStagedCode {
  /** The language of the runner image the script is run in. */
  language: string;
  /** The entry path from the Workflow tree root. */
  file: string;
  /** Inline script for older jobs and the one-release file alias / worker rollback. */
  source?: string;
  tree?: { workflow: string; revisionId: string; hash: string };
  /** One-release alias compatibility: relative input.json/output.json in writable scratch. */
  legacyIo?: true;
  /** The mapped input. A dataset in it is its reference; the worker hands the script a file. */
  input: JsonObject;
  timeoutSeconds: number;
  /**
   * Present where the step's output names a dataset: the output schema with the row schema of
   * every dataset written out, and the Workflow's `limits.datasetBytes` where it set one. The
   * worker stores each file the script names there against its row schema.
   */
  datasets?: { outputSchema: JsonObject; maxBytes?: number };
}

/** How the script of a code step ended, before the engine has checked what it returned. */
export type WorkflowCodeOutcome =
  { kind: "output"; value: JsonValue } | { kind: "failed"; error: WorkflowRunError };

/**
 * How many items of a loop run at once. `asked` is the loop's `concurrency`, an upper bound.
 * `ranWith` is what one process of the instance runs of it: the step slots of a process bound
 * every loop, so a loop that asks for more runs with as many items as a process has slots.
 */
export interface WorkflowLoopConcurrency {
  asked: number;
  ranWith: number;
}

/** Which runs of a Workflow a list answers by their run key: one key, or the keys under a prefix. */
export type WorkflowRunKeyFilter = { exact: string } | { prefix: string };

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

/** How a step run ended. The preview of its resolved input is recorded before dispatch. */
export interface WorkflowStepRunEnd {
  status: Exclude<WorkflowStepRunStatus, "queued" | "running" | "waiting">;
  finishedAt: ISODateString;
  output?: JsonValue;
  operationRunId?: OperationRunId;
  error?: WorkflowRunError;
  /** What the operation of the step does and what it belongs to, where it was resolved. */
  call?: WorkflowStepRunCall;
}

export interface WorkflowRunsStore {
  /** Serializes published Workflow edges until the calling transaction commits. */
  lockDefinitionGraph(input: { clientInstanceId: ClientInstanceId }): Promise<void>;
  /** Serializes keyed wait links per instance until commit; acquire before run row locks. */
  lockRunLinks(input: { clientInstanceId: ClientInstanceId }): Promise<void>;
  /** A step owns at most one child, including after a crashed start. */
  findRunByOperation(ref: {
    clientInstanceId: ClientInstanceId;
    operationRunId: OperationRunId;
  }): Promise<WorkflowRunView | undefined>;
  findChildRun(ref: WorkflowStepRunRef): Promise<WorkflowRunView | undefined>;
  listChildRuns(ref: WorkflowRunRef): Promise<WorkflowRunView[]>;
  readRunOutput(ref: WorkflowRunRef): Promise<{ value: JsonValue } | undefined>;
  markChildWaiting(
    ref: WorkflowStepRunRef & { operationRunId?: OperationRunId; call?: WorkflowStepRunCall }
  ): Promise<void>;
  /**
   * Moves a running `operation` step run to `waiting` for an Operation Run of an operation
   * with `completion: async`, unless that Operation Run has ended. It holds the Operation Run
   * while it decides, so the end of that run either sees the step waiting and wakes it, or
   * ended before and the step is answered from it. Answers whether the step run waits.
   */
  waitForOperation(
    ref: WorkflowStepRunRef & { operationRunId: OperationRunId; call?: WorkflowStepRunCall }
  ): Promise<boolean>;

  /**
   * Writes a run as `queued`. Answers nothing, and writes nothing, where the run names a due
   * time of a schedule that a run of the same Workflow already has (a due time starts once),
   * or a run key that a run of the same Workflow and mode holds. The insert meets the key's
   * unique index: a start that holds the same key and has not committed is waited for.
   */
  createRun(run: NewWorkflowRun): Promise<WorkflowRun | undefined>;
  /**
   * The run of a Workflow and mode that holds a key: open or `done`, as the key's index has it.
   * Read after `createRun` answered nothing, in the same transaction, and held until it ends,
   * so its end either comes before (and is read) or after this transaction (and sees a step
   * that links to it). Nothing where the holder ended `failed`, `cancelled` or `limit_reached`
   * in between.
   */
  lockRunByKey(input: {
    clientInstanceId: ClientInstanceId;
    workflow: string;
    mode: WorkflowRunMode;
    runKey: string;
  }): Promise<WorkflowRun | undefined>;
  /**
   * Keeps on the step run of a `workflow` step the run its start was answered by key, which
   * the step waits for and does not own.
   */
  linkStepRun(ref: WorkflowStepRunRef & { linkedRunId: WorkflowRunId }): Promise<void>;
  /** The step runs that have not ended and wait for a run they are linked to. */
  listLinkedStepRuns(ref: WorkflowRunRef): Promise<WorkflowStepRunId[]>;
  /**
   * What a due time of a Workflow's schedule meets: whether a run for it exists, and whether
   * a run an earlier due time started has not ended. Called inside the admission transaction;
   * serializes admissions for this instance and Workflow until that transaction ends.
   */
  readScheduleState(input: {
    clientInstanceId: ClientInstanceId;
    workflow: string;
    scheduledFor: ISODateString;
  }): Promise<{ fired: boolean; open: boolean }>;
  /**
   * Reads a run and holds its row until the transaction ends. Every write to a run or to one
   * of its step runs is made behind it, so a step that ends and a cancel never both win.
   */
  lockRun(ref: WorkflowRunRef): Promise<WorkflowRun | undefined>;
  /**
   * Marks a run as waiting from `at` where every open step of it waits for something outside
   * it: an `operation` step on an asynchronous operation, or a `workflow` step whose child
   * waits as well. A step that is queued or running, and a code step whose script runs, is
   * work of the run. Behind the run's lock. Answers whether the run now waits.
   */
  markRunWaiting(ref: WorkflowRunRef & { at: ISODateString }): Promise<boolean>;
  /**
   * Ends the wait of a run that waits, at `at`: its deadline moves later by the time it
   * waited, which is added to `waitedMs`. Behind the run's lock. Answers the run as it now
   * stands, or nothing where it was not waiting.
   */
  endRunWait(ref: WorkflowRunRef & { at: ISODateString }): Promise<WorkflowRun | undefined>;
  /** API projection, including failed descendants. Never used by engine execution paths. */
  readRunView(ref: {
    clientInstanceId: ClientInstanceId;
    id: string;
  }): Promise<WorkflowRunView | undefined>;
  /** A single-row engine read, without descendant aggregation. Unknown ids answer undefined. */
  readRun(input: {
    clientInstanceId: ClientInstanceId;
    id: string;
  }): Promise<WorkflowRunView | undefined>;
  /**
   * The runs of one Workflow, newest first, by creation time and id: all of them, or those
   * whose run key is `key`, or starts with `keyPrefix` taken as it is written.
   */
  listRuns(input: {
    clientInstanceId: ClientInstanceId;
    workflow: string;
    key?: WorkflowRunKeyFilter;
    page?: StorePage;
  }): Promise<WorkflowRunView[]>;
  /**
   * The ids of at most `limit` runs of one Workflow that have not ended, oldest first: what a
   * retirement of the Workflow cancels. It walks the Workflow's runs, so it is for rare work.
   */
  listOpenRunIds(input: {
    clientInstanceId: ClientInstanceId;
    workflow: string;
    limit: number;
  }): Promise<WorkflowRunId[]>;
  /**
   * The latest run of each of the named Workflows, by creation time and id. A Workflow that
   * never ran has no entry.
   */
  listLastRuns(input: {
    clientInstanceId: ClientInstanceId;
    workflows: readonly string[];
  }): Promise<Map<string, WorkflowLastRun>>;
  /** The run's input, as the trigger step hands it on. */
  readRunInput(ref: WorkflowRunRef): Promise<JsonObject | undefined>;
  /** The bounded loop position carried from the previous history. */
  readCheckpoint(ref: WorkflowRunRef): Promise<NewWorkflowRun["checkpoint"]>;
  /** The definition a run was started on. `id` is whatever a caller named. */
  readRunDefinition(input: {
    clientInstanceId: ClientInstanceId;
    id: string;
  }): Promise<WorkflowManifest | undefined>;
  /** Moves a `queued` run to `running`. A run in another status is left as it is. */
  markRunRunning(ref: WorkflowRunRef & { startedAt: ISODateString }): Promise<void>;
  /** Marks the initial history as part 1 under its lock, before its successor is created. */
  markContinuation(ref: WorkflowRunRef): Promise<void>;
  /** Transfer non-owning waits to the successor without waking them at an intermediate end. */
  handoffContinuation(ref: WorkflowRunRef & { successorId: WorkflowRunId }): Promise<void>;
  /** Ends a run that has not ended. Answers whether this call ended it. */
  endRun(
    ref: WorkflowRunRef & {
      status: (typeof WORKFLOW_ENDED_STATUSES)[number];
      finishedAt: ISODateString;
      output?: JsonValue;
      error?: WorkflowRunError;
      /** On a cancel: the person who cancelled. The moment is `finishedAt`. */
      cancelledBy?: WorkflowRunRecordView["cancelledBy"];
    }
  ): Promise<boolean>;
  /** Writes a step run as `queued` and counts it on its run. */
  createStepRun(stepRun: NewWorkflowStepRun): Promise<WorkflowStepRun>;
  getStepRun(ref: WorkflowStepRunRef): Promise<WorkflowStepRun | undefined>;
  /** Moves a step run that has not ended to `running` under the number of the attempt. */
  markStepRunRunning(
    ref: WorkflowStepRunRef & { attempt: number; startedAt: ISODateString }
  ): Promise<void>;
  /** Keeps the cut preview of the resolved input before dispatch, while the step is running. */
  recordStepRunInput(ref: WorkflowStepRunRef & { preview: WorkflowOutputPreview }): Promise<void>;
  /** Ends a step run that has not ended. Answers whether this call ended it. */
  endStepRun(ref: WorkflowStepRunRef & WorkflowStepRunEnd): Promise<boolean>;
  /**
   * Moves a running loop step run to `waiting` and keeps the list it runs over. From then on
   * the step runs of its items carry the loop on, and its own job has nothing left to do.
   */
  readLoopDataset(ref: WorkflowStepRunRef): Promise<WorkflowDatasetReference | undefined>;
  markLoopWaiting(
    ref: WorkflowStepRunRef & {
      items: readonly JsonValue[] | WorkflowDatasetReference;
      /** Dataset batches count iterations rather than rows. */
      total?: number;
      /** The id of the loop's last step. An item is done when the step run of that step is. */
      lastStepId?: string;
      firstStepId?: string;
    }
  ): Promise<void>;
  /**
   * Keeps the id of the Operation Run of a step's call on a step run that has not ended, as
   * soon as it is known and before the call has an outcome.
   */
  noteStepRunOperation(ref: WorkflowStepRunRef & { operationRunId: OperationRunId }): Promise<void>;
  /**
   * Moves a running code step run to `waiting` and keeps what its container is given. From
   * then on the command worker has the step, and the engine takes it up when the script ended.
   */
  stageCodeStep(ref: WorkflowStepRunRef & { staged: WorkflowStagedCode }): Promise<void>;
  /** What a waiting code step run's container is given. Nothing once it has an outcome. */
  readStagedCode(ref: WorkflowStepRunRef): Promise<WorkflowStagedCode | undefined>;
  /**
   * Keeps how the script of a waiting code step run ended, with its log, and drops the script
   * and the input. Answers whether the step run was waiting for it: one that a cancel ended
   * keeps nothing.
   */
  recordCodeOutcome(
    ref: WorkflowStepRunRef & { outcome: WorkflowCodeOutcome; log: WorkflowStepRunLog }
  ): Promise<boolean>;
  /** How the script of a code step run ended, where it has. */
  readCodeOutcome(ref: WorkflowStepRunRef): Promise<WorkflowCodeOutcome | undefined>;
  /** The step runs of a run that have not ended. */
  listOpenStepRuns(ref: WorkflowRunRef): Promise<WorkflowStepRun[]>;
  /**
   * Runs due for pruning or repair by the current retention owner, oldest first and at
   * most `limit` of them. Includes already marked rows pruned by an older owner. An open
   * run is never among them, however old it is: what carries it on reads its values.
   */
  listRunsWithDataEndedBefore(input: {
    clientInstanceId: ClientInstanceId;
    endedBefore: ISODateString;
    limit: number;
  }): Promise<WorkflowRunId[]>;
  /**
   * Removes every value (including staged code, raw outcomes, logs and item labels) of
   * at most `limit` step runs of one run, in one statement. A loop keeps its item count and
   * last step name so counts read as before. Answers how many step runs it took them from.
   */
  pruneStepRunData(ref: WorkflowRunRef & { limit: number }): Promise<number>;
  /**
   * Removes all run values and stamps the current retention version, only after every
   * step is clear. Preserves the first prune time on repair. Answers whether this call did.
   */
  markRunDataPruned(ref: WorkflowRunRef & { prunedAt: ISODateString }): Promise<boolean>;
  /**
   * The step runs of one run in the order they were created: all of them, or those of one
   * block, of one status and of one item of a loop.
   */
  listStepRuns(input: {
    clientInstanceId: ClientInstanceId;
    runId: WorkflowRunId;
    filter?: WorkflowStepRunFilter;
    page?: StorePage;
  }): Promise<WorkflowStepRunView[]>;
  /**
   * The output of the step run of `stepId` that ended as `done` in one place of the run: at
   * the top where `containerStepRunId` is missing, otherwise in that item of that loop.
   */
  findStepOutput(input: {
    clientInstanceId: ClientInstanceId;
    runId: WorkflowRunId;
    stepId: string;
    containerStepRunId?: WorkflowStepRunId;
    iteration?: number;
  }): Promise<{ value: JsonValue } | undefined>;
  /** How many items the list of a loop step run holds, once the loop resolved it. */
  countLoopItems(ref: WorkflowStepRunRef): Promise<number | undefined>;
  /**
   * How many items of a loop step run have been started: one more than the highest item that
   * has a step run. Items start in the order of the list, so every item below it has started.
   */
  readLoopProgress(ref: WorkflowStepRunRef): Promise<{ started: number; running: number }>;
  countLoopItemsStarted(ref: WorkflowStepRunRef): Promise<number>;
  /** One item of the list of a loop step run, without reading the list. */
  readLoopItem(
    ref: WorkflowStepRunRef & { index: number }
  ): Promise<{ value: JsonValue } | undefined>;
  /**
   * How far the items of a loop step run are, as they stand now. An item is failed when one of
   * its step runs is, running while one of them has not ended, and done when the step run of
   * the loop's last step is. An item that was cut off between two of its steps, by a cancel
   * or a limit, is none of the three.
   */
  readLoopCounts(ref: WorkflowStepRunRef): Promise<WorkflowLoopCounts | undefined>;
}

/** The trigger kind of a run an outside client started, and of a Workflow that admits one. */
export const WORKFLOW_OUTSIDE_TRIGGER = "outside";

/**
 * Whether what a live run reads answers an outside client: its root was started by one. A
 * test run answers the person testing, whose own key's calls are asked by `isOutsideCall`.
 */
export async function answersOutsideClient(
  workflowRuns: Pick<WorkflowRunsStore, "readRun">,
  clientInstanceId: ClientInstanceId,
  run: Pick<WorkflowRun, "id" | "rootRunId" | "mode" | "trigger">
): Promise<boolean> {
  if (run.mode !== "live") return false;
  const root =
    run.rootRunId === run.id
      ? run
      : await workflowRuns.readRun({ clientInstanceId, id: run.rootRunId });
  // A root that cannot be read counts as one an outside client started: never guess open.
  return root === undefined || root.trigger === WORKFLOW_OUTSIDE_TRIGGER;
}
