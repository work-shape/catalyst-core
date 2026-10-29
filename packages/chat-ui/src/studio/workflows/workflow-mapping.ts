import type { Asset } from "@work-shape/catalyst-api-client";
import {
  CONNECTION_EXPOSURE_ACTION_PREFIX,
  WORKFLOW_ACTIONS,
  WORKFLOW_RUN_MODES,
  WORKFLOW_STEP_TYPES,
  WORKFLOW_RESERVED_STEP_TYPES,
  WORKFLOW_TRIGGER_KINDS,
  parseConnectionOperationName,
  type ModelUsageRefusal,
  type WorkflowBlockStepRunView,
  type WorkflowKind,
  type WorkflowLoopCounts,
  type WorkflowRunDataset,
  type WorkflowRunLineage,
  type WorkflowRunStatus,
  type WorkflowStepRunCall,
  type WorkflowStepRunLink,
  type WorkflowStepRunPlacement,
  type WorkflowStepRunStatus
} from "@work-shape/catalyst-core";
import type { AssetVerb } from "../../shared/build-rights";
import { isMailStep, mailViewOf } from "./mail-step";
import { NO_START_FORM, nameFromId, startFormOf, type StartForm } from "./start-form";
import type {
  WorkflowBranchView,
  WorkflowDatasetColumn,
  WorkflowDatasetColumnKind,
  WorkflowDatasetView,
  WorkflowFailure,
  WorkflowFailureReason,
  WorkflowListItem,
  WorkflowOutputPreview,
  WorkflowRunView,
  WorkflowStartIssue,
  WorkflowStepKind,
  WorkflowStepRunView,
  WorkflowStepSource,
  WorkflowStepFacts,
  WorkflowStepView,
  WorkflowView
} from "./workflow-views";

// The mapping from what the instance answers to what a screen shows. A change of the contract
// is made here and in the source that calls it, and in no screen.

/** The codes the engine and a refused or failed operation write, by what the screens say. */
const FAILURE_REASONS: Readonly<Record<string, WorkflowFailureReason>> = {
  FORBIDDEN: "missingRight",
  POLICY_DENIED: "policy",
  GUARDRAIL_BLOCKED: "guardrail",
  DECLINED: "needsApproval",
  operation_would_wait: "needsApproval",
  confirmation_unattended: "confirmationUnattended",
  principal_inactive: "accountInactive",
  run_as_disabled: "accountInactive",
  tester_missing_right: "testerMissingRight",
  tester_key_unusable: "testerKeyUnusable",
  tester_key_scope: "testerKeyScope",
  tester_key_cannot_carry: "testerKeyCannotCarry",
  operation_not_found: "operationMissing",
  operation_input_invalid: "dataMismatch",
  reference_unresolved: "dataMismatch",
  loop_items_not_a_list: "dataMismatch",
  run_key_invalid: "dataMismatch",
  run_key_cycle: "runKeyCycle",
  reach_person_only: "reachPersonOnly",
  output_not_json: "dataMismatch",
  output_invalid: "outputInvalid",
  step_data_too_large: "tooMuchData",
  loop_too_long: "tooMuchData",
  dataset_limit: "tooMuchData",
  step_type_not_executed: "notSupported",
  not_supported_yet: "notSupported",
  operation_interrupted: "interrupted",
  operation_still_running: "stillRunning",
  step_crashed: "crashed",
  loop_step_failed: "loopEntry",
  step_limit: "stepLimit",
  duration_limit: "durationLimit",
  MODEL_USAGE_LIMIT_REACHED: "usageLimit"
};

/**
 * A shape of the contract as it arrives: an id is a string on the wire, whatever the contract
 * brands it as.
 */
type OnTheWire<Shape> = {
  [Key in keyof Shape]: NonNullable<Shape[Key]> extends { readonly __brand: string }
    ? string
    : Shape[Key];
};

interface ErrorResource {
  code: string;
  message: string;
  /** On a refused call: the action the account of the Workflow would have needed. */
  action?: string;
  /** On a refused `connection.use`: the Connection the step called. */
  connection?: string;
  /** That Connection's title, where the reader may read or use it. */
  connectionTitle?: string;
  /** On `confirmation_unattended`: the operation that needed a confirmation. */
  operation?: string;
  /** On `MODEL_USAGE_LIMIT_REACHED`: which usage limit refused a model call. */
  usageLimit?: ModelUsageRefusal | undefined;
}

interface TimesResource {
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

/** A dataset as a run or a step run names it: what the screens show of its record. */
interface WorkflowDatasetResource extends Pick<
  WorkflowRunDataset,
  "id" | "rowCount" | "bytes" | "state"
> {
  /** A JSON Schema of one row; the contract carries it as an open object. */
  rowSchema: Readonly<Record<string, unknown>>;
}

/**
 * A run as the engine's read answers it: the fields the screens read, with the names of the
 * run view of the contract. The engine's slice maps its resource onto this.
 */
export interface WorkflowRunResource extends TimesResource, Partial<OnTheWire<WorkflowRunLineage>> {
  id: string;
  workflow: string;
  trigger: (typeof WORKFLOW_TRIGGER_KINDS)[number];
  /** `test` on a test run of the draft. */
  mode?: (typeof WORKFLOW_RUN_MODES)[number];
  /** On a test run an App's draft started: the App, by name (DP-1). */
  startedFrom?: { kind: "app"; app: string };
  status: WorkflowRunStatus;
  startedBy: { id: string; label: string };
  /** The account the run acts as. */
  principal?: { displayLabel: string };
  /** On a child run: the id of the Workflow of the run that started it. */
  parentWorkflow?: string;
  /** The run key its start gave the run. */
  runKey?: string;
  labels?: Readonly<Record<string, string>>;
  /** On a part of a run that continued as new (EW-CAN). */
  continuation?: { rootRunId: string; previousRunId?: string; number: number };
  /** How many step runs the run made. */
  stepRunCount?: number;
  /** The revision of the definition the run started on. */
  definitionRevisionId?: string;
  error?: ErrorResource;
  outputPreview?: WorkflowOutputPreview;
  datasets?: readonly WorkflowDatasetResource[];
  /** When someone asked to cancel the run. It ends when the call that is going has ended. */
  cancelledAt?: string;
  /** True on a run that ended `done` without a write step handling an item. */
  empty?: boolean;
  /** Runs below it, at any depth, that failed, reached a limit or left failed items. */
  failedDescendantCount?: number;
  /** Failed loop items through this continuation part, counted when the run ended. */
  failedItemCount?: number;
}

/** A step run as the engine's read answers it, with the placement the contract names. */
export interface WorkflowStepRunResource
  extends
    TimesResource,
    OnTheWire<WorkflowStepRunPlacement>,
    WorkflowStepRunCall,
    WorkflowBlockStepRunView,
    OnTheWire<WorkflowStepRunLink> {
  id: string;
  stepId: string;
  stepType: string;
  status: WorkflowStepRunStatus;
  attempt: number;
  /** On the step run of a loop: how far its items are. */
  loop?: WorkflowLoopCounts;
  /** On the step run of a `workflow` step: the child run it started. Contract need C7. */
  childRunId?: string;
  agent?: WorkflowStepRunView["agent"];
  /** On the step run of a condition that has decided. Contract need C3. */
  taken?: string;
  error?: ErrorResource;
  /** What the step got: only for a reader who may read the run's data. */
  inputPreview?: WorkflowOutputPreview;
  outputPreview?: WorkflowOutputPreview;
  datasets?: readonly WorkflowDatasetResource[];
}

/**
 * The Workflow a `workflow` step could not start because its run key is held in the step's own
 * call chain. The engine writes no field for it, only its generated sentence
 * "The operation 'workflow.<name>.start' failed (run_key_cycle)"; the name is read from that
 * sentence alone and only where it has a Workflow's name form, so no key or value passes.
 */
const RUN_KEY_CYCLE_SENTENCE =
  /^The operation 'workflow\.([a-z][a-z0-9_-]{0,62})\.start' failed \(run_key_cycle\)$/u;

function cycleWorkflowOf(error: ErrorResource): string | undefined {
  return error.code === "run_key_cycle"
    ? RUN_KEY_CYCLE_SENTENCE.exec(error.message)?.[1]
    : undefined;
}

/**
 * A refusal because the step's operation is not open to the run: `FORBIDDEN` with the action
 * `connection_exposure:<exposure>`, which no grant carries, so it is never read as a missing
 * right. The engine's sentence starts with the operation it refused; only a Connection's name
 * that has the form of one is read from it, for the sentence that says where to open it.
 */
function notExposedOf(
  error: ErrorResource
): Pick<WorkflowFailure, "exposure" | "connection"> | undefined {
  if (error.code !== "FORBIDDEN" || !error.action?.startsWith(CONNECTION_EXPOSURE_ACTION_PREFIX)) {
    return undefined;
  }
  const surface = error.action.slice(CONNECTION_EXPOSURE_ACTION_PREFIX.length);
  const operation = /^'([^'\s]+)' /u.exec(error.message)?.[1];
  const connection =
    error.connection ??
    (operation === undefined ? undefined : parseConnectionOperationName(operation)?.connection);
  return {
    ...(surface === "workflow" || surface === "outside" ? { exposure: surface } : {}),
    ...(connection === undefined ? {} : { connection })
  };
}

function toFailure(error: ErrorResource | undefined) {
  if (error === undefined) return {};
  const workflow = cycleWorkflowOf(error);
  const notExposed = notExposedOf(error);
  if (notExposed !== undefined) {
    return {
      failure: {
        reason: "notExposed" as const,
        detail: error.message,
        ...notExposed,
        ...(error.connectionTitle === undefined ? {} : { connectionTitle: error.connectionTitle })
      }
    };
  }
  return {
    failure: {
      reason: FAILURE_REASONS[error.code] ?? "other",
      detail: error.message,
      ...(error.action === undefined ? {} : { action: error.action }),
      ...(error.connection === undefined ? {} : { connection: error.connection }),
      ...(error.connectionTitle === undefined ? {} : { connectionTitle: error.connectionTitle }),
      ...(error.operation === undefined ? {} : { operation: error.operation }),
      ...(error.usageLimit === undefined ? {} : { usageLimit: error.usageLimit }),
      ...(workflow === undefined ? {} : { workflow })
    }
  };
}

function toOutput(preview: WorkflowOutputPreview | undefined) {
  return preview === undefined
    ? {}
    : { output: { text: preview.text, truncated: preview.truncated } };
}

/** JSON Schema's `type` of a column, by what the screens call it. */
const COLUMN_KINDS: Readonly<Record<string, WorkflowDatasetColumnKind>> = {
  string: "text",
  number: "number",
  integer: "wholeNumber",
  boolean: "yesNo",
  object: "record",
  array: "list"
};

function columnKind(schema: unknown): WorkflowDatasetColumnKind {
  if (typeof schema !== "object" || schema === null || !("type" in schema)) {
    return "value";
  }
  const types: unknown[] = Array.isArray(schema.type) ? schema.type : [schema.type];
  // A column that may be empty is of the type it holds where it is not.
  const named = types.filter((type) => typeof type === "string" && type !== "null");
  const only = named.length === 1 ? named[0] : undefined;
  return typeof only === "string" ? (COLUMN_KINDS[only] ?? "value") : "value";
}

/** The columns a dataset's row schema names, in the order of its `properties`. */
function datasetColumns(rowSchema: WorkflowDatasetResource["rowSchema"]): WorkflowDatasetColumn[] {
  const properties = rowSchema.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    return [];
  }
  return Object.entries(properties).map(([field, schema]) => ({ field, kind: columnKind(schema) }));
}

function toDatasets(datasets: readonly WorkflowDatasetResource[] | undefined) {
  return datasets === undefined
    ? {}
    : {
        datasets: datasets.map((dataset): WorkflowDatasetView => ({
          id: dataset.id,
          rowCount: dataset.rowCount,
          bytes: dataset.bytes,
          state: dataset.state,
          columns: datasetColumns(dataset.rowSchema)
        }))
      };
}

function times(resource: TimesResource) {
  return {
    createdAt: resource.createdAt,
    ...(resource.startedAt === undefined ? {} : { startedAt: resource.startedAt }),
    ...(resource.finishedAt === undefined ? {} : { finishedAt: resource.finishedAt })
  };
}

/** A run in one of these states changes no more. */
function workflowRunEnded(status: WorkflowRunStatus): boolean {
  return status !== "queued" && status !== "running" && status !== "waiting";
}

/** A run as the screens show it. */
export function toWorkflowRun(run: WorkflowRunResource): WorkflowRunView {
  return {
    id: run.id,
    workflowId: run.workflow,
    status: run.status,
    ended: workflowRunEnded(run.status),
    stopping: run.cancelledAt !== undefined && !workflowRunEnded(run.status),
    // A run its schedule or another run started names no person.
    startedBy:
      run.trigger === "manual" || run.trigger === "outside"
        ? { id: run.startedBy.id, name: run.startedBy.label }
        : undefined,
    ...(run.principal === undefined ? {} : { runsAs: run.principal.displayLabel }),
    ...times(run),
    ...toFailure(run.error),
    ...toOutput(run.outputPreview),
    ...toDatasets(run.datasets),
    ...(run.definitionRevisionId === undefined ? {} : { revisionId: run.definitionRevisionId }),
    test: run.mode === "test",
    ...(run.mode === "test" && run.startedFrom !== undefined
      ? { fromApp: run.startedFrom.app }
      : {}),
    ...(run.runKey === undefined ? {} : { runKey: run.runKey }),
    ...(run.continuation === undefined ? {} : { continuation: run.continuation }),
    ...(run.labels === undefined || Object.keys(run.labels).length === 0
      ? {}
      : { labels: run.labels }),
    ...(run.stepRunCount === undefined ? {} : { stepRuns: run.stepRunCount }),
    empty: run.empty === true && run.status === "done",
    failedDescendantCount: run.failedDescendantCount ?? 0,
    failedItemCount: run.failedItemCount ?? 0,
    ...(run.parentRunId === undefined || run.parentWorkflow === undefined
      ? {}
      : { parent: { runId: run.parentRunId, workflowId: run.parentWorkflow } })
  };
}

const STEP_KINDS: readonly WorkflowStepKind[] = [
  ...WORKFLOW_STEP_TYPES,
  ...WORKFLOW_RESERVED_STEP_TYPES
];

function stepKind(type: unknown): WorkflowStepKind | undefined {
  return STEP_KINDS.find((candidate) => candidate === type);
}

/** A step run as the screens show it. A step type no screen knows reads as an operation. */
export function toWorkflowStepRun(stepRun: WorkflowStepRunResource): WorkflowStepRunView {
  const childRunId = stepRun.childRunId ?? stepRun.linkedRunId;
  return {
    id: stepRun.id,
    ...(stepRun.agent ? { agent: stepRun.agent } : {}),
    stepId: stepRun.stepId,
    kind: stepKind(stepRun.stepType) ?? "operation",
    status: stepRun.status,
    attempt: stepRun.attempt,
    ...(stepRun.containerStepRunId === undefined
      ? {}
      : { containerStepRunId: stepRun.containerStepRunId }),
    ...(stepRun.branch === undefined ? {} : { branch: stepRun.branch }),
    ...(stepRun.iteration === undefined ? {} : { iteration: stepRun.iteration }),
    ...(stepRun.loop === undefined ? {} : { loop: stepRun.loop }),
    ...(stepRun.bodyCounts === undefined ? {} : { bodyCounts: stepRun.bodyCounts }),
    ...(stepRun.taken === undefined ? {} : { taken: stepRun.taken }),
    ...(stepRun.effect === undefined ? {} : { effect: stepRun.effect }),
    ...(stepRun.source === undefined ? {} : { source: stepRun.source }),
    ...(stepRun.target === undefined ? {} : { target: stepRun.target }),
    ...(stepRun.publishedWouldAsk === undefined
      ? {}
      : { publishedWouldAsk: stepRun.publishedWouldAsk }),
    ...(childRunId === undefined ? {} : { childRunId }),
    ...times(stepRun),
    ...toFailure(stepRun.error),
    ...(stepRun.inputPreview === undefined
      ? {}
      : { input: { text: stepRun.inputPreview.text, truncated: stepRun.inputPreview.truncated } }),
    ...toOutput(stepRun.outputPreview),
    ...toDatasets(stepRun.datasets)
  };
}

/** A Workflow as the engine's list names it: what has a published definition. */
export interface WorkflowSummaryResource {
  id: string;
  name: string;
  description?: string;
  /** `process` unless the published definition says `data`. */
  kind?: WorkflowKind;
  /** The id of the published revision: what a run started now names as its own. */
  definitionRevisionId?: string;
  /** The workspace that owns it. Absent where the instance does. */
  workspaceId?: string;
  /** Why the instance accepts no start by hand now. Empty where it does. */
  reasons?: readonly WorkflowStartIssue[];
  /** What the caller may do with the Workflow, by the names of the actions. */
  actions?: readonly string[];
  /** The published revision's `inputs`: the JSON Schema a start's input is checked against. */
  inputs?: Readonly<Record<string, unknown>>;
  /** The label of the account every run acts as, where it is active. */
  runsAs?: string;
  /** The latest run of the Workflow, where it has one. */
  lastRun?: {
    id: string;
    status: WorkflowRunStatus;
    startedAt?: string;
    /** Runs below it, at any depth, that failed, reached a limit or left failed items. */
    failedDescendantCount?: number;
    /** Failed loop items through this continuation part, counted when the run ended. */
    failedItemCount?: number;
  };
}

/** The reasons of a summary as the screens hold them: the code and the sentence. */
function startIssues(summary: WorkflowSummaryResource | undefined): WorkflowStartIssue[] {
  return (summary?.reasons ?? []).map(({ code, message, principalDisplayLabel, path }) => ({
    code,
    message,
    ...(path === undefined ? {} : { path }),
    ...(principalDisplayLabel === undefined ? {} : { principalDisplayLabel })
  }));
}

/** Whether the caller may start the Workflow, as its entry of the list says. */
function mayStartOf(summary: WorkflowSummaryResource | undefined): boolean {
  return summary?.actions?.includes(WORKFLOW_ACTIONS.use) === true;
}

/**
 * What the list says of a Workflow beside its definition: the published revision's id, why no
 * start is accepted, whether the reader may start it, and the form a start asks. A Workflow
 * the list does not name is not the reader's to start.
 */
export function listedOf(summary: WorkflowSummaryResource | undefined): WorkflowListed {
  return {
    ...(summary?.definitionRevisionId === undefined
      ? {}
      : { revisionId: summary.definitionRevisionId }),
    refusedFor: startIssues(summary),
    mayStart: mayStartOf(summary),
    startForm: startFormOf(summary?.inputs),
    ...(summary?.runsAs === undefined ? {} : { runsAs: summary.runsAs })
  };
}

/** What `listedOf` reads. */
export interface WorkflowListed {
  /** The id of the published revision, which a run names as the one it started on. */
  revisionId?: string;
  /** Why the instance accepts no start of the Workflow now, as its list says it. */
  refusedFor?: readonly WorkflowStartIssue[];
  /** The reader holds the right to start it. */
  mayStart?: boolean;
  /**
   * The form of a start, from the published revision's inputs: the draft's may ask for
   * other values than a run accepts.
   */
  startForm?: StartForm;
  /** The account every run acts as, by its label. */
  runsAs?: string;
}

/**
 * A Workflow as a row of the list. `asset` is the Workflow's asset row: what the reader may do
 * to it and who owns it. The engine's entry names the start alone.
 */
export function toWorkflowListItem(
  summary: WorkflowSummaryResource,
  asset?: Pick<WorkflowAssetListed, "allowed" | "scope" | "appCallers">
): WorkflowListItem {
  const description = summary.description?.trim();
  const { lastRun } = summary;
  return {
    id: summary.id,
    name: summary.name.trim() || summary.id,
    ...(description ? { description } : {}),
    // The engine lists what has a published definition.
    published: true,
    kind: summary.kind ?? "process",
    // A Workflow without a start by hand is refused for that alone.
    startsByHand: !(summary.reasons ?? []).some(({ code }) => code === "no_manual_trigger"),
    refusedFor: startIssues(summary),
    mayStart: mayStartOf(summary),
    ...assetRightsOf(asset),
    ...appCallersOf(asset),
    // A reader who only starts it reads no asset row: the engine's entry names the owner.
    ...(asset?.scope === undefined && summary.workspaceId !== undefined
      ? { ownerWorkspaceId: summary.workspaceId }
      : {}),
    startForm: startFormOf(summary.inputs),
    ...(lastRun === undefined
      ? {}
      : {
          lastRun: {
            id: lastRun.id,
            status: lastRun.status,
            ...(lastRun.startedAt === undefined ? {} : { startedAt: lastRun.startedAt }),
            failedDescendantCount: lastRun.failedDescendantCount ?? 0,
            failedItemCount: lastRun.failedItemCount ?? 0
          }
        })
  };
}

/** What a list of Workflow assets says of one, as far as a row of a draft reads it. */
export interface WorkflowAssetListed {
  name: string;
  title: string;
  description?: string;
  publishedRevision?: number;
  updatedAt: string;
  /** What the kind's summary adds to the row, such as `workflowKind`. */
  attributes?: Readonly<Record<string, string | boolean>>;
  /** What the reader may do to the Workflow, where the instance says it. */
  allowed?: readonly AssetVerb[];
  /** Who owns it: the instance, or one workspace. */
  scope?: Asset["scope"];
  /** The Apps that start it, as far as the reader may open them, by title. */
  appCallers?: Asset["appCallers"];
}

/** The Apps a record or a row names as starting the Workflow, where it names any. */
export function appCallersOf(
  asset: Pick<WorkflowAssetListed, "appCallers"> | undefined
): Pick<WorkflowListItem, "appCallers"> {
  const callers = asset?.appCallers ?? [];
  return callers.length === 0
    ? {}
    : {
        appCallers: callers.map((caller) => ({
          id: caller.name,
          title: caller.title.trim() || caller.name,
          ...(caller.scope.kind === "workspace" ? { workspaceId: caller.scope.workspaceId } : {})
        }))
      };
}

/** What a record or a row says of the reader's rights on a Workflow and of its owner. */
function assetRightsOf(
  asset: Pick<WorkflowAssetListed, "allowed" | "scope"> | undefined
): Pick<WorkflowListItem, "allowed" | "ownerWorkspaceId"> {
  return {
    ...(asset?.allowed === undefined ? {} : { allowed: asset.allowed }),
    ...(asset?.scope?.kind === "workspace" ? { ownerWorkspaceId: asset.scope.workspaceId } : {})
  };
}

/**
 * A Workflow the engine does not list to the reader, as a row of the list from its asset: one
 * never published, or a published one the reader may write or publish but neither read nor
 * start. The engine names no start for it, so none is offered here.
 */
export function toAssetWorkflowListItem(asset: WorkflowAssetListed): WorkflowListItem {
  const description = asset.description?.trim();
  return {
    id: asset.name,
    name: asset.title.trim() || nameFromId(asset.name),
    ...(description ? { description } : {}),
    published: asset.publishedRevision !== undefined,
    // The asset list names the draft's kind; a row without it is a process.
    kind: asset.attributes?.workflowKind === "data" ? "data" : "process",
    updatedAt: asset.updatedAt,
    startsByHand: false,
    refusedFor: [],
    mayStart: false,
    ...assetRightsOf(asset),
    ...appCallersOf(asset),
    startForm: NO_START_FORM
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** The distinct ids of a list, in their first order: nothing else is kept. */
function ids(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value.filter((entry): entry is string => typeof entry === "string" && entry !== "")
        )
      ]
    : [];
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

interface StepNames {
  facts?: Asset["stepFacts"];
  tools: readonly string[];
  /** The names of the steps that can be referred to, by id. */
  names: ReadonlyMap<string, string>;
  triggerId: string | undefined;
  /** The loops around the step, by id, with what each calls its entries. */
  loops: ReadonlyMap<string, string | undefined>;
  /** What each step returns, as a schema, where the definition or the instance says it. */
  results?: ReadonlyMap<string, unknown>;
}

/** The title a schema gives the field at a dotted path, where it gives one. */
function fieldTitle(schema: unknown, path: string): string | undefined {
  let current = schema;
  for (const part of path === "" ? [] : path.split(".")) {
    const properties = isRecord(current) ? current.properties : undefined;
    current = isRecord(properties) ? properties[part] : undefined;
  }
  return isRecord(current) ? text(current.title) : undefined;
}

/** What each step of the list returns, as a schema: the trigger returns the run's input. */
function stepResults(
  manifest: Readonly<Record<string, unknown>>,
  facts: WorkflowStepFacts | undefined
): Map<string, unknown> {
  const results = new Map<string, unknown>();
  const walk = (value: unknown) => {
    for (const raw of records(value)) {
      const id = text(raw.id);
      if (id === undefined) continue;
      results.set(
        id,
        raw.type === "trigger"
          ? { type: "object", properties: { input: manifest.inputs } }
          : (raw.outputSchema ?? facts?.[id]?.outputSchema)
      );
      walk(raw.steps);
      walk(raw.then);
      walk(raw.else);
      for (const branch of records(raw.branches)) walk(branch.steps);
    }
  };
  walk(manifest.steps);
  return results;
}

/** Where a field of an earlier result comes from, and the field in words. */
function fieldRef(
  ref: { step: string; path: string },
  known: StepNames
): { from: WorkflowStepSource; field: string } {
  const field =
    fieldTitle(known.results?.get(ref.step), ref.path) ??
    (ref.path.split(".").at(-1) || (known.names.get(ref.step) ?? nameFromId(ref.step)));
  if (ref.step === known.triggerId) return { from: { from: "run_input" }, field };
  if (known.loops.has(ref.step)) {
    const itemName = known.loops.get(ref.step);
    return { from: { from: "loop_entry", ...(itemName === undefined ? {} : { itemName }) }, field };
  }
  return { from: { from: "step", name: known.names.get(ref.step) ?? nameFromId(ref.step) }, field };
}

function stepSources(input: unknown, known: StepNames): WorkflowStepSource[] {
  const sources: WorkflowStepSource[] = [];
  const seen = new Set<string>();
  // A field is a literal, a reference, or a text whose parts may each be a reference.
  const references = (isRecord(input) ? Object.values(input) : []).flatMap((field) =>
    isRecord(field) && Array.isArray(field.text) ? field.text : [field]
  );
  for (const field of references) {
    const step = isRecord(field) && isRecord(field.ref) ? text(field.ref.step) : undefined;
    if (step === undefined || seen.has(step)) {
      continue;
    }
    seen.add(step);
    if (step === known.triggerId) {
      sources.push({ from: "run_input" });
    } else if (known.loops.has(step)) {
      const itemName = known.loops.get(step);
      sources.push({ from: "loop_entry", ...(itemName === undefined ? {} : { itemName }) });
    } else {
      sources.push({ from: "step", name: known.names.get(step) ?? nameFromId(step) });
    }
  }
  return sources;
}

/**
 * The steps of one list of the file, in its order: the file is a step list with nested blocks
 * and has no edges. A step of a type no screen knows is left out.
 */
function readSteps(value: unknown, known: StepNames): WorkflowStepView[] {
  const steps: WorkflowStepView[] = [];
  for (const raw of records(value)) {
    const id = text(raw.id);
    const kind = stepKind(raw.type);
    if (id === undefined || kind === undefined) {
      continue;
    }
    const description = text(raw.description);
    const itemName = text(raw.itemName);
    const fact = known.facts?.[id];
    const source = fact?.source?.title;
    const service = fact?.source?.service;
    const child = text(raw.workflow);
    const triggers = records(raw.triggers);
    const schedule = triggers.find((trigger) => text(trigger.cron) !== undefined);
    const cron = text(schedule?.cron);
    const timeZone = text(schedule?.timeZone);
    const sourceKind =
      fact?.source?.kind === "connection" || fact?.source?.kind === "data_store"
        ? fact.source.kind
        : undefined;
    const inside: StepNames =
      kind === "loop" ? { ...known, loops: new Map([...known.loops, [id, itemName]]) } : known;
    const branches: WorkflowBranchView[] | undefined =
      kind === "condition"
        ? [
            { id: "then", steps: readSteps(raw.then, inside) },
            { id: "else", steps: readSteps(raw.else, inside) }
          ]
        : kind === "parallel"
          ? records(raw.branches).flatMap((branch) => {
              const branchId = text(branch.id);
              const name = text(branch.name);
              return branchId === undefined
                ? []
                : [
                    {
                      id: branchId,
                      ...(name === undefined ? {} : { name }),
                      steps: readSteps(branch.steps, inside)
                    }
                  ];
            })
          : undefined;
    steps.push({
      id,
      kind,
      ...(kind === "agent" ? { instructions: text(raw.instructions), tools: known.tools } : {}),
      name: text(raw.name) ?? nameFromId(id),
      ...(description === undefined ? {} : { description }),
      ...(kind === "trigger"
        ? {
            starts: {
              byHand: triggers.some((trigger) => trigger.kind === "manual"),
              onSchedule: triggers.some((trigger) => trigger.kind === "schedule"),
              ...(cron === undefined ? {} : { cron }),
              ...(timeZone === undefined ? {} : { timeZone })
            }
          }
        : {}),
      ...(itemName === undefined ? {} : { itemName }),
      ...(kind === "loop" && isRecord(raw.items) && text(raw.items.step) !== undefined
        ? { itemsFrom: text(raw.items.step) }
        : {}),
      ...(kind === "loop" && typeof raw.concurrency === "number" && raw.concurrency > 1
        ? { concurrency: raw.concurrency }
        : {}),
      ...(fact?.effect === undefined ? {} : { effect: fact.effect }),
      ...(source === undefined ? {} : { source }),
      ...(sourceKind === undefined ? {} : { sourceKind }),
      ...(service === undefined ? {} : { service }),
      ...(kind === "workflow" && child !== undefined ? { workflow: child } : {}),
      steps: kind === "loop" ? readSteps(raw.steps, inside) : [],
      ...(branches === undefined ? {} : { branches }),
      ...(kind === "notify"
        ? {
            channel:
              Array.isArray(raw.channels) && raw.channels.includes("mail") ? "mail" : "inbox",
            to: {
              users: ids(isRecord(raw.to) ? raw.to.users : undefined),
              workspaces: ids(isRecord(raw.to) ? raw.to.workspaces : undefined)
            }
          }
        : {}),
      sources: stepSources(raw.input, known),
      ...(isMailStep(raw)
        ? { mail: mailViewOf(raw.input, fact, (ref) => fieldRef(ref, known)) }
        : {})
    });
  }
  return steps;
}

function stepNames(value: unknown, names = new Map<string, string>()): Map<string, string> {
  for (const raw of records(value)) {
    const id = text(raw.id);
    if (id !== undefined) {
      names.set(id, text(raw.name) ?? nameFromId(id));
      stepNames(raw.steps, names);
      stepNames(raw.then, names);
      stepNames(raw.else, names);
      for (const branch of records(raw.branches)) {
        stepNames(branch.steps, names);
      }
    }
  }
  return names;
}

/** One Workflow from its record: the definition is the record's `config`. */
/** The steps of `workflow.yaml` as the screens show them, with what the instance says of each. */
export function workflowSteps(
  manifest: Readonly<Record<string, unknown>>,
  facts?: WorkflowStepFacts
): WorkflowStepView[] {
  const triggerId = records(manifest.steps)
    .filter((step) => step.type === "trigger")
    .map((step) => text(step.id))[0];
  return readSteps(manifest.steps, {
    facts,
    names: stepNames(manifest.steps),
    tools: ids(manifest.tools),
    triggerId,
    loops: new Map(),
    results: stepResults(manifest, facts)
  });
}

export function toWorkflow(
  asset: Pick<Asset, "name" | "config" | "publishedRevision">,
  {
    revisionId,
    refusedFor = [],
    mayStart = false,
    startForm = NO_START_FORM,
    runsAs
  }: WorkflowListed = {},
  /**
   * The asset's own pointers, and what the reader may do to it. The instance names a draft only
   * to who may read it.
   */
  pointers: Partial<
    Pick<
      Asset,
      | "draftRevision"
      | "publishedRevision"
      | "publishQuestion"
      | "publishHandover"
      | "publishDataStores"
      | "allowed"
      | "scope"
      | "stepFacts"
    >
  > = {}
): WorkflowView {
  const definition = asset.config;
  const description = text(definition.description);
  const steps = workflowSteps(definition, pointers.stepFacts);
  return {
    id: asset.name,
    name: text(definition.name) ?? asset.name,
    ...(description === undefined ? {} : { description }),
    ...(runsAs === undefined ? {} : { runsAs }),
    published: asset.publishedRevision !== undefined,
    ...(revisionId === undefined ? {} : { revisionId }),
    steps,
    startsByHand: steps.some((step) => step.starts?.byHand === true),
    startForm,
    refusedFor,
    mayStart,
    ...assetRightsOf(pointers),
    ...(pointers.draftRevision === undefined
      ? {}
      : {
          draft: {
            revision: pointers.draftRevision,
            // The steps above are the draft's where the reader is shown it, and so are its inputs.
            testForm: startFormOf(definition.inputs),
            ...(pointers.publishQuestion?.length
              ? { publishQuestion: pointers.publishQuestion }
              : {}),
            ...(pointers.publishDataStores?.length
              ? {
                  publishDataStores: pointers.publishDataStores.map(
                    ({ name, title, revision, pendingMigrations }) => ({
                      name,
                      title,
                      revision,
                      pendingMigrations
                    })
                  )
                }
              : {}),
            ...(pointers.publishHandover?.confirmation
              ? { handoverConfirmation: pointers.publishHandover.confirmation }
              : {}),
            ...(pointers.publishedRevision === undefined
              ? {}
              : { publishedRevision: pointers.publishedRevision })
          }
        })
  };
}
