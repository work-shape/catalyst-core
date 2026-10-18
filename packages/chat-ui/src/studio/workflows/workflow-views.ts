import {
  NOTIFY_CHANNELS,
  type WorkflowKind,
  OPERATION_EFFECTS,
  OPERATION_TARGETS,
  WORKFLOW_RESERVED_STEP_TYPES,
  type WorkflowDatasetState,
  WORKFLOW_RUN_STATUSES,
  WORKFLOW_STEP_TYPES
} from "@work-shape/catalyst-core";
// What the Workflow screens show: a Workflow, its steps, a run and its step runs, in the
// screens' own shapes. The data module maps what the instance answers onto these, so no screen
// reads a type of the API contract.

import type { AssetVerb } from "../../shared/build-rights";
import type { StartForm } from "./start-form";

/** A Workflow as a row of the list. */
export interface WorkflowListItem {
  id: string;
  name: string;
  description?: string;
  /** A revision is published: there is something to open and to start. */
  published: boolean;
  /**
   * `data` fills or processes a Knowledge Base or a Data Store and is listed behind the Data
   * flows filter; `process` is everything else. A draft never published takes the kind its
   * asset row names.
   */
  kind: WorkflowKind;
  /** When it was last changed, where the list names it. */
  updatedAt?: string;
  /** A person may start it, as far as the instance says. */
  startsByHand: boolean;
  /** Why the instance accepts no start of it now. Empty where it does. */
  refusedFor: readonly WorkflowStartIssue[];
  /** The reader holds the right to start it. */
  mayStart: boolean;
  /**
   * What the reader may do to this Workflow's asset, as the instance decides it with every grant
   * and deny there is, those on this Workflow included. Absent where the instance said nothing:
   * the rights on its owner stand then. Starting it is `mayStart`'s.
   */
  allowed?: readonly AssetVerb[];
  /** The workspace that owns it, where one does. Absent for the instance's own. */
  ownerWorkspaceId?: string;
  /** What a start asks for: the fields of the published revision's inputs. */
  startForm: StartForm;
  /** The latest run, where the instance names it on the list. */
  lastRun?: WorkflowLastRunView;
}

/** The latest run of a Workflow, as its row of the list names it. */
interface WorkflowLastRunView {
  id: string;
  status: WorkflowRunStatus;
  startedAt?: string;
  /** Runs below it, at any depth, that failed, reached a limit or left failed items. */
  failedDescendantCount: number;
  /** Items of its own loops that failed, as the instance counted them when the run ended. */
  failedItemCount: number;
}

export type WorkflowStepKind =
  (typeof WORKFLOW_STEP_TYPES)[number] | (typeof WORKFLOW_RESERVED_STEP_TYPES)[number];

/** One path of a `condition` (`then`, `else`) or of a `parallel` step. */
export interface WorkflowBranchView {
  id: string;
  /** On a path of a `parallel` step. The paths of a condition are named by the interface. */
  name?: string;
  steps: readonly WorkflowStepView[];
}

/** Where a step takes one of its inputs from. */
export type WorkflowStepSource =
  | { from: "step"; name: string }
  /** What the run was started with. */
  | { from: "run_input" }
  /** The entry of the loop the step runs in. */
  | { from: "loop_entry"; itemName?: string };

/** One step of a Workflow as its definition describes it. */
export interface WorkflowStepView {
  id: string;
  kind: WorkflowStepKind;
  name: string;
  description?: string;
  /** On an operation step: whether it reads or changes, where the instance says it. */
  effect?: (typeof OPERATION_EFFECTS)[number];
  /** On an operation step: the name of what it works on, where the instance gives one. */
  source?: string;
  /** On an operation step: what kind of thing that is, as far as the operation's name says. */
  sourceKind?: "connection" | "data_store";
  /** On an operation step of a Connection: the Connection's `service`, which names its icon. */
  service?: string;
  /** On a trigger: what may start a run, and the cron expression of its schedule. */
  starts?: { byHand: boolean; onSchedule: boolean; cron?: string };
  /** On a loop: how many entries run at once, where the definition says more than one. */
  concurrency?: number;
  /** On a `workflow` step: the id of the Workflow it starts. */
  workflow?: string;
  /** On a `condition` or `parallel` step: its paths, in their order. */
  branches?: readonly WorkflowBranchView[];
  /** On a loop: the id of the step whose result holds its entries. */
  itemsFrom?: string;
  /** On a loop: what one entry is called, where the definition says it. */
  itemName?: string;
  /** On a loop: the steps it runs for each entry, in their order. */
  steps: readonly WorkflowStepView[];
  /** On a notice: where it goes. */
  channel?: (typeof NOTIFY_CHANNELS)[number];
  /** The steps whose results the step is given. */
  sources: readonly WorkflowStepSource[];
}

/** One Workflow with what it does. */
export interface WorkflowView {
  id: string;
  name: string;
  description?: string;
  /** The account every run acts as, by its label, where the instance names it. */
  runsAs?: string;
  published: boolean;
  /** The id of the revision that is published, which is the one the page draws. */
  revisionId?: string;
  steps: readonly WorkflowStepView[];
  /** A person may start it, as far as its definition says. */
  startsByHand: boolean;
  /** What a start asks for: the fields of the published revision's inputs. */
  startForm: StartForm;
  /**
   * Why the instance accepts no start of the Workflow now, as it says it. With one entry the
   * Workflow is shown and cannot be started.
   */
  refusedFor: readonly WorkflowStartIssue[];
  /** The reader holds the right to start this Workflow, as its entry of the list says. */
  mayStart: boolean;
  /**
   * What the reader may do to this Workflow's asset, as the instance decides it with every grant
   * and deny there is, those on this Workflow included. Absent where the instance said nothing:
   * the rights on its owner stand then. Starting it is `mayStart`'s.
   */
  allowed?: readonly AssetVerb[];
  /** The workspace that owns it, where one does. Absent for the instance's own. */
  ownerWorkspaceId?: string;
  /**
   * The draft, where the instance showed it to the reader: the steps above are then the
   * draft's. Absent for a reader who is answered the published revision.
   */
  draft?: WorkflowDraftView;
}

/** The two pointers of a Workflow whose draft the reader is shown, as revision numbers. */
interface WorkflowDraftView {
  revision: number;
  /** Absent before the first publish. */
  publishedRevision?: number;
  /** What a test run of the draft asks for: the fields of the draft's inputs. */
  testForm: StartForm;
  /**
   * What a publish of the draft asks about beyond its steps, in the instance's sentences: each
   * limit the draft raises above its default. Absent where it raises none.
   */
  publishQuestion?: readonly string[];
}

/** One "Run live once" switch of the reader's, by step, and the test run that used it. */
export interface LiveOnceSwitchView {
  step: string;
  switchedAt: string;
  used?: { runId: string; at: string };
}

/** Where the call of a step went: the live asset, its test target, or nowhere (simulated). */
export type WorkflowStepTarget = (typeof OPERATION_TARGETS)[number];

/** One thing the instance refuses a start for: its code and its own sentence. */
export interface WorkflowStartIssue {
  code: string;
  /** The instance's fallback sentence, which it writes in English. */
  message: string;
  principalDisplayLabel?: string;
}

export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

type WorkflowStepRunStatus = Exclude<WorkflowRunStatus, "limit_reached" | "continued">;

/**
 * Why a run or a step did not end as done, as far as the instance names it by a code. `other`
 * is every code the screens have no sentence for, such as one of an outside system.
 */
export type WorkflowFailureReason =
  | "missingRight"
  /** In a test run: the person testing lacks a right a step needs. */
  | "testerMissingRight"
  | "policy"
  | "guardrail"
  | "needsApproval"
  | "accountInactive"
  | "operationMissing"
  | "dataMismatch"
  | "outputInvalid"
  | "tooMuchData"
  | "notSupported"
  | "interrupted"
  /** The step stopped waiting for work that ends later, at its timeout; the work goes on. */
  | "stillRunning"
  | "crashed"
  | "loopEntry"
  | "stepLimit"
  | "durationLimit"
  /** A `workflow` step's run key is held by a run in its own call chain. */
  | "runKeyCycle"
  | "other";

export interface WorkflowFailure {
  reason: WorkflowFailureReason;
  /** The instance's own sentence, which it writes in English. */
  detail: string;
  /** On a missing right: the action the account of the Workflow does not hold. */
  action?: string;
  /** On a run key held in the call chain: the name of the Workflow the step would start. */
  workflow?: string;
}

/** The start of what a run or a step returned, as JSON. */
export interface WorkflowOutputPreview {
  text: string;
  truncated: boolean;
}

/** What a column of a dataset holds, as its row schema says it. */
export type WorkflowDatasetColumnKind =
  "text" | "number" | "wholeNumber" | "yesNo" | "record" | "list" | "value";

/** One column of a dataset's rows, by the field name its row schema gives. */
export interface WorkflowDatasetColumn {
  field: string;
  kind: WorkflowDatasetColumnKind;
}

/**
 * A dataset a step wrote: rows kept beside the run, which its output names by a reference
 * (`{ $dataset, rowCount, bytes }`) instead of carrying them.
 */
export interface WorkflowDatasetView {
  id: string;
  rowCount: number;
  bytes: number;
  /** `writing` until its step ended; `deleted` once the run's data was removed. */
  state: WorkflowDatasetState;
  columns: readonly WorkflowDatasetColumn[];
}

/** One run of a Workflow. */
export interface WorkflowRunView {
  id: string;
  workflowId: string;
  status: WorkflowRunStatus;
  /** The run has left the states it changes in. */
  ended: boolean;
  /** Someone asked to cancel the run, and the call that is going has not ended yet. */
  stopping: boolean;
  /** Who started it. A run its schedule started names nobody. */
  startedBy: { id: string; name: string } | undefined;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  failure?: WorkflowFailure;
  output?: WorkflowOutputPreview;
  /** The datasets of the run's steps, where the instance names them. */
  datasets?: readonly WorkflowDatasetView[];
  /** The id of the revision of the definition the run started on. */
  revisionId?: string;
  /**
   * A test run of the draft: it acts as the person who started it, bounded by the Workflow's
   * account, and simulates the steps that change something.
   */
  test: boolean;
  /** The run whose step started this one, where it is a child run. */
  parent?: { runId: string; workflowId: string };
  /**
   * Runs below this one, at any depth, that failed, reached a limit or left failed items, as
   * the instance counts them. A run that ended `done` with some reads as a warning.
   */
  failedDescendantCount: number;
  /**
   * Items of this run's own loops that failed, as the instance counted them when the run ended.
   * A run that ended `done` with some reads as a warning.
   */
  failedItemCount: number;
  /**
   * The run key its start gave it, such as `2026-09/1402`. Every part of a run that continued
   * as new holds the same key; `continuation` numbers the parts.
   */
  runKey?: string;
  /**
   * Where the run is one part of a run that continued as new: the id of the first part, the
   * part before this one, and its number from 1. The first part gains it once it continues.
   */
  continuation?: { rootRunId: string; previousRunId?: string; number: number };
  /** What the run is labelled with, by name. The parts of a continued run keep the first's. */
  labels?: Readonly<Record<string, string>>;
  /** How many step runs the run made, where the instance counts them. */
  stepRuns?: number;
  /**
   * The run ended `done` without a write step handling an item: a data run that found nothing
   * to do. The instance marks the run itself, so a later change of the Workflow's kind leaves
   * the runs before it as they were.
   */
  empty: boolean;
}

/** How far a loop is, as the instance counts it. */
export interface WorkflowLoopCounts {
  total: number;
  done: number;
  failed: number;
  running: number;
}

/** One step run of a run. */
export interface WorkflowStepRunView {
  id: string;
  /** The id of the step in the definition. */
  stepId: string;
  kind: WorkflowStepKind;
  status: WorkflowStepRunStatus;
  attempt: number;
  /** The step run of the block this one stands in: a loop, a condition or a parallel step. */
  containerStepRunId?: string;
  /** The path of that block the step stands on: `then`, `else` or the id of a branch. */
  branch?: string;
  /** Which entry of a loop, from 0, and what the loop's label field holds for it. */
  iteration?: { index: number; label?: string };
  /** On the step run of a loop. */
  loop?: WorkflowLoopCounts;
  /** On the step run of a loop or a parallel step: how its own steps stand, by step id. */
  bodyCounts?: Readonly<Record<string, WorkflowLoopCounts>>;
  /** On the step run of a condition that has decided: the path it took. */
  taken?: string;
  /** On the step run of an operation step: what the call does and what it belongs to. */
  effect?: (typeof OPERATION_EFFECTS)[number];
  source?: string;
  /** On the step run of an operation step: where its call went. */
  target?: WorkflowStepTarget;
  /**
   * In a test run: the tester's start let the step run without asking, and a run of the
   * published revision asks for an approval here.
   */
  publishedWouldAsk?: "approval";
  /** On the step run of a `workflow` step: the child run it started or was answered. */
  childRunId?: string;
  failure?: WorkflowFailure;
  output?: WorkflowOutputPreview;
  /** The datasets the step wrote, where the instance names them. */
  datasets?: readonly WorkflowDatasetView[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}
