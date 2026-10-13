// What the Workflow screens show: a Workflow, its steps, a run and its step runs, in the
// screens' own shapes. The data module maps what the instance answers onto these, so no screen
// reads a type of the API contract.

import type { StartForm } from "./start-form";

/** A Workflow as a row of the list. */
export interface WorkflowListItem {
  id: string;
  name: string;
  description?: string;
  /** A revision is published: there is something to open and to start. */
  published: boolean;
  /** When it was last changed, where the list names it. */
  updatedAt?: string;
  /** A person may start it, as far as the instance says. */
  startsByHand: boolean;
  /** Why the instance accepts no start of it now. Empty where it does. */
  refusedFor: readonly WorkflowStartIssue[];
  /** The reader holds the right to start it. */
  mayStart: boolean;
  /** What a start asks for: the fields of the published revision's inputs. */
  startForm: StartForm;
  /** The latest run, where the instance names it on the list. */
  lastRun?: { id: string; status: WorkflowRunStatus; startedAt?: string };
}

export type WorkflowStepKind =
  | "trigger"
  | "operation"
  | "loop"
  | "code"
  | "agent"
  | "notify"
  | "output"
  /** Starts another Workflow as a child run and waits for it. */
  | "workflow"
  /** Reserved in the contract: drawn, and run by no engine yet. */
  | "condition"
  | "parallel";

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
  effect?: "reading" | "changing";
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
  channel?: "inbox" | "mail";
  /** The steps whose results the step is given. */
  sources: readonly WorkflowStepSource[];
}

/** One Workflow with what it does. */
export interface WorkflowView {
  id: string;
  name: string;
  description?: string;
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
}

/** One thing the instance refuses a start for: its code and its own sentence. */
export interface WorkflowStartIssue {
  code: string;
  /** The instance's own sentence, which it writes in English. */
  message: string;
}

export type WorkflowRunStatus =
  "queued" | "running" | "waiting" | "done" | "failed" | "cancelled" | "limit_reached";

type WorkflowStepRunStatus = Exclude<WorkflowRunStatus, "limit_reached">;

/**
 * Why a run or a step did not end as done, as far as the instance names it by a code. `other`
 * is every code the screens have no sentence for, such as one of an outside system.
 */
export type WorkflowFailureReason =
  | "missingRight"
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
  | "crashed"
  | "loopEntry"
  | "stepLimit"
  | "durationLimit"
  | "other";

export interface WorkflowFailure {
  reason: WorkflowFailureReason;
  /** The instance's own sentence, which it writes in English. */
  detail: string;
  /** On a missing right: the action the account of the Workflow does not hold. */
  action?: string;
}

/** The start of what a run or a step returned, as JSON. */
export interface WorkflowOutputPreview {
  text: string;
  truncated: boolean;
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
  /** The id of the revision of the definition the run started on. */
  revisionId?: string;
  /** The run whose step started this one, where it is a child run. */
  parent?: { runId: string; workflowId: string };
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
  effect?: "reading" | "changing";
  source?: string;
  /** On the step run of a `workflow` step: the child run it started or was answered. */
  childRunId?: string;
  failure?: WorkflowFailure;
  output?: WorkflowOutputPreview;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}
