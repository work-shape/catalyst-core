import {
  NOTIFY_CHANNELS,
  type WorkflowKind,
  OPERATION_EFFECTS,
  type OperationSourceKind,
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
  /** The Apps that start it, as far as the reader may open them, by title. */
  appCallers?: readonly WorkflowAppCallerView[];
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

/** A field of an earlier result a step takes, in the words of the screens. */
interface WorkflowFieldRefView {
  /** The step id and the dotted path of the reference, as the definition holds them. */
  step: string;
  path: string;
  /** Whose field it is: an earlier step's, the run's start, or the loop's entry. */
  from: WorkflowStepSource;
  /** The field's name in words. */
  field: string;
}

/** One part of a text a step joins: written text, or a field of an earlier result. */
export type WorkflowTextPartView = string | { ref: WorkflowFieldRefView };

/** One recipient of a Send email step as its definition names it. */
export type WorkflowMailRecipientView =
  | { kind: "user"; id: string }
  | { kind: "workspace"; id: string }
  | { kind: "address"; address: string }
  /** The list or address a field of an earlier result gives when the step runs. */
  | { kind: "picked"; ref: WorkflowFieldRefView };

/**
 * The mail a Send email step sends (an operation step on `mail.send`, MAIL-3a): what its input
 * holds, and whom it sends as from the instance's step facts. A field in a form the screens do
 * not read is absent.
 */
export interface WorkflowMailView {
  /** The sender the step names: `system` until a Connection sender exists. */
  sender: string;
  /** The sender's name and address, and the icon key it shows, where the instance says them. */
  senderTitle?: string;
  senderAddress?: string;
  icon?: string;
  /** The domains outside the instance it may send to; empty for people of the instance only. */
  recipientDomains?: readonly string[];
  to?: readonly WorkflowMailRecipientView[];
  cc?: readonly WorkflowMailRecipientView[];
  bcc?: readonly WorkflowMailRecipientView[];
  /** Fields of the input in a form the screens do not read. */
  unshown?: readonly string[];
  subject?: readonly WorkflowTextPartView[];
  body?: readonly WorkflowTextPartView[];
  senderName?: string;
  replyTo?: string;
  replyToUser?: string;
  locale?: string;
}

/** One step of a Workflow as its definition describes it. */
export interface WorkflowStepView {
  id: string;
  kind: WorkflowStepKind;
  name: string;
  instructions?: string;
  tools?: readonly string[];
  description?: string;
  /** On an operation step: whether it reads or changes, where the instance says it. */
  effect?: (typeof OPERATION_EFFECTS)[number];
  /** On an operation step: the name of what it works on, where the instance gives one. */
  source?: string;
  /** On an operation step: what kind of thing that is, as far as the operation's name says. */
  sourceKind?: "connection" | "data_store";
  /** On an operation step of a Connection: the Connection's `service`, which names its icon. */
  service?: string;
  /**
   * On a trigger: what may start a run, the cron expression of its schedule, and the zone its
   * clock time is in, where the schedule names one. Without one it runs in the instance's.
   */
  starts?: { byHand: boolean; onSchedule: boolean; cron?: string; timeZone?: string };
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
  /** On a notice: who receives it, by the ids of people and workspaces the definition names. */
  to?: { users: readonly string[]; workspaces: readonly string[] };
  /** The steps whose results the step is given. */
  sources: readonly WorkflowStepSource[];
  /** On a step that sends an e-mail: the mail. */
  mail?: WorkflowMailView;
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
  /**
   * The revision the steps above are of, as it is stored: what editing by hand changes. Absent
   * where the source holds no drafts, such as samples.
   */
  definition?: WorkflowDefinitionView;
  /**
   * The Workflows whose steps call this one, in a draft or published revision the reader may
   * read, as the instance names them. Absent where the source does not say.
   */
  callers?: readonly WorkflowCallerView[];
  /** The Apps whose actions start it, as far as the reader may open them, by title. */
  appCallers?: readonly WorkflowAppCallerView[];
}

/** An App one of whose actions starts a Workflow. */
export interface WorkflowAppCallerView {
  /** Its name, which addresses it. */
  id: string;
  /** What it is called. */
  title: string;
  /** The workspace that owns it. Absent for the instance's own. */
  workspaceId?: string;
}

/** A Workflow one of whose steps calls another. */
export interface WorkflowCallerView {
  /** Its name, which addresses it. */
  id: string;
  /** What it is called. */
  title: string;
  /** The workspace that owns it. Absent for the instance's own. */
  workspaceId?: string;
}

/**
 * What the instance says of each step beyond its definition, by step id, as its read answered
 * it: among it what the step gets and what it returns (`inputSchema`, `outputSchema`).
 */
export type WorkflowStepFacts = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/**
 * One operation a step may call, as the instance lists it for the reader
 * (`operations.list_callable`): only what the reader may call is listed.
 */
export interface CallableOperationOption {
  /** What the step writes under `operation`. */
  name: string;
  title: string;
  description?: string;
  effect: (typeof OPERATION_EFFECTS)[number];
  /** What it belongs to; a source the reader may not read has its kind alone. */
  source: {
    kind: OperationSourceKind;
    title?: string;
    service?: string;
  };
  /** False where a call cannot reach its source now. */
  available: boolean;
  inputSchema?: Readonly<Record<string, unknown>>;
}

/** A published Workflow a step may start and wait for: one that lists the trigger `parent`. */
export interface ChildWorkflowOption {
  id: string;
  name: string;
  /** What it asks for when started, as JSON Schema. */
  inputs?: Readonly<Record<string, unknown>>;
  /**
   * Whether the reader may start it too (`workflow.use`), which a parent's start of it needs.
   * One the reader may only read is shown, and cannot be picked.
   */
  mayStart: boolean;
}

/** A revision of a Workflow as it is stored: `workflow.yaml` and the files of its steps. */
export interface WorkflowDefinitionView {
  /** The whole config of the revision: its name, its manifest and its files. */
  config: Readonly<Record<string, unknown>>;
  /** `workflow.yaml`. */
  manifest: Readonly<Record<string, unknown>>;
  /** The revision's number: the one a save names as the revision it read. */
  revision: number;
  stepFacts?: WorkflowStepFacts;
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
  path?: string;
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
  /**
   * What the step calls is not open to the run: not exposed to Workflows, or to outside clients
   * where one started the run. No right opens it; the Connection's exposure does.
   */
  | "notExposed"
  /** In a test run: the person testing lacks a right a step needs. */
  | "testerMissingRight"
  | "policy"
  | "guardrail"
  | "needsApproval"
  | "confirmationUnattended"
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
  /**
   * On a refused `connection.use`, or an operation not exposed: the Connection the step called,
   * where the instance names it.
   */
  connection?: string;
  /** On `notExposed`: what the operation is not open to, Workflows or outside clients. */
  exposure?: "workflow" | "outside";
  /** That Connection's title, where the reader may read or use it. */
  connectionTitle?: string;
  /** On a run key held in the call chain: the name of the Workflow the step would start. */
  workflow?: string;
  /** On a confirmation an agent step could not get: the operation that needed it. */
  operation?: string;
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
  /**
   * The account the run acted as, by its label, where the instance names it. It is the run's
   * own, so a later change of the Workflow's account leaves the runs before it as they were.
   */
  runsAs?: string;
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
  /** On a test run a click in an App's draft started: the App, by name (DP-1). */
  fromApp?: string;
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
/** The bounded transcript of an agent step's run, for a reader with run-data access. */
export interface WorkflowStepTranscriptView {
  messages: readonly {
    role: string;
    text: string;
    toolCalls?: readonly { toolName: string; input?: unknown }[];
  }[];
  truncated: boolean;
}

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
  /** On an agent step: its Agent Run, its status and its usage. */
  agent?: {
    runId: string;
    status: string;
    usage: {
      modelCallCount: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    };
  };
  failure?: WorkflowFailure;
  /**
   * What the step got, after its references were resolved: given only to a reader who may read
   * the run's data.
   */
  input?: WorkflowOutputPreview;
  output?: WorkflowOutputPreview;
  /** The datasets the step wrote, where the instance names them. */
  datasets?: readonly WorkflowDatasetView[];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}
