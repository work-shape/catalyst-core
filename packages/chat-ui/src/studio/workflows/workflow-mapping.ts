import type { Asset } from "@work-shape/catalyst-api-client";
import {
  CONNECTION_OPERATION_PREFIX,
  DATA_STORE_OPERATION_PREFIX,
  WORKFLOW_ACTIONS,
  WORKFLOW_RUN_MODES,
  WORKFLOW_TRIGGER_KINDS,
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
import { NO_START_FORM, nameFromId, startFormOf, type StartForm } from "./start-form";
import type {
  WorkflowBranchView,
  WorkflowDatasetColumn,
  WorkflowDatasetColumnKind,
  WorkflowDatasetView,
  WorkflowFailureReason,
  WorkflowListItem,
  WorkflowOutputPreview,
  WorkflowRunView,
  WorkflowStartIssue,
  WorkflowStepKind,
  WorkflowStepRunView,
  WorkflowStepSource,
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
  principal_inactive: "accountInactive",
  run_as_disabled: "accountInactive",
  tester_missing_right: "testerMissingRight",
  operation_not_found: "operationMissing",
  operation_input_invalid: "dataMismatch",
  reference_unresolved: "dataMismatch",
  loop_items_not_a_list: "dataMismatch",
  run_key_invalid: "dataMismatch",
  run_key_cycle: "runKeyCycle",
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
  duration_limit: "durationLimit"
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
  status: WorkflowRunStatus;
  startedBy: { id: string; label: string };
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
  /** On the step run of a condition that has decided. Contract need C3. */
  taken?: string;
  error?: ErrorResource;
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

function toFailure(error: ErrorResource | undefined) {
  if (error === undefined) return {};
  const workflow = cycleWorkflowOf(error);
  return {
    failure: {
      reason: FAILURE_REASONS[error.code] ?? "other",
      detail: error.message,
      ...(error.action === undefined ? {} : { action: error.action }),
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
      run.trigger === "manual" ? { id: run.startedBy.id, name: run.startedBy.label } : undefined,
    ...times(run),
    ...toFailure(run.error),
    ...toOutput(run.outputPreview),
    ...toDatasets(run.datasets),
    ...(run.definitionRevisionId === undefined ? {} : { revisionId: run.definitionRevisionId }),
    test: run.mode === "test",
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
  "trigger",
  "operation",
  "loop",
  "code",
  "agent",
  "notify",
  "output",
  "workflow",
  "condition",
  "parallel"
];

function stepKind(type: unknown): WorkflowStepKind | undefined {
  return STEP_KINDS.find((candidate) => candidate === type);
}

/** A step run as the screens show it. A step type no screen knows reads as an operation. */
export function toWorkflowStepRun(stepRun: WorkflowStepRunResource): WorkflowStepRunView {
  const childRunId = stepRun.childRunId ?? stepRun.linkedRunId;
  return {
    id: stepRun.id,
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
  return (summary?.reasons ?? []).map(({ code, message, principalDisplayLabel }) => ({
    code,
    message,
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

/** A Workflow as a row of the list. */
export function toWorkflowListItem(summary: WorkflowSummaryResource): WorkflowListItem {
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
}

/**
 * A Workflow never published, as a row of the list: the engine names it nowhere, so its asset
 * does. Nothing starts it until a person publishes it.
 */
export function toDraftWorkflowListItem(asset: WorkflowAssetListed): WorkflowListItem {
  const description = asset.description?.trim();
  return {
    id: asset.name,
    name: asset.title.trim() || nameFromId(asset.name),
    ...(description ? { description } : {}),
    published: false,
    // The asset list names the draft's kind; a row without it is a process.
    kind: asset.attributes?.workflowKind === "data" ? "data" : "process",
    updatedAt: asset.updatedAt,
    startsByHand: false,
    refusedFor: [],
    mayStart: false,
    startForm: NO_START_FORM
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

interface StepNames {
  /** The names of the steps that can be referred to, by id. */
  names: ReadonlyMap<string, string>;
  triggerId: string | undefined;
  /** The loops around the step, by id, with what each calls its entries. */
  loops: ReadonlyMap<string, string | undefined>;
}

function stepSources(input: unknown, known: StepNames): WorkflowStepSource[] {
  const sources: WorkflowStepSource[] = [];
  const seen = new Set<string>();
  for (const field of isRecord(input) ? Object.values(input) : []) {
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

/** What an operation works on, as far as its name says: a Connection or a Data Store. */
function sourceKindOf(operation: string | undefined): WorkflowStepView["sourceKind"] {
  if (operation?.startsWith(CONNECTION_OPERATION_PREFIX) === true) {
    return "connection";
  }
  return operation?.startsWith(DATA_STORE_OPERATION_PREFIX) === true ? "data_store" : undefined;
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
    const source = text(raw.source);
    const service = text(raw.service);
    const child = text(raw.workflow);
    const triggers = records(raw.triggers);
    const cron = triggers.map((trigger) => text(trigger.cron)).find((entry) => entry !== undefined);
    const sourceKind = kind === "operation" ? sourceKindOf(text(raw.operation)) : undefined;
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
      name: text(raw.name) ?? nameFromId(id),
      ...(description === undefined ? {} : { description }),
      ...(kind === "trigger"
        ? {
            starts: {
              byHand: triggers.some((trigger) => trigger.kind === "manual"),
              onSchedule: triggers.some((trigger) => trigger.kind === "schedule"),
              ...(cron === undefined ? {} : { cron })
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
      // The definition names an operation and not what it does. A read that says whether the
      // step reads or changes, what it works on and the `service` of its Connection is shown;
      // without one the step has its name and a generic icon. Contract need C8.
      ...(raw.effect === "reading" || raw.effect === "changing" ? { effect: raw.effect } : {}),
      ...(source === undefined ? {} : { source }),
      ...(sourceKind === undefined ? {} : { sourceKind }),
      ...(service === undefined ? {} : { service }),
      ...(kind === "workflow" && child !== undefined ? { workflow: child } : {}),
      steps: kind === "loop" ? readSteps(raw.steps, inside) : [],
      ...(branches === undefined ? {} : { branches }),
      ...(kind === "notify"
        ? {
            channel: Array.isArray(raw.channels) && raw.channels.includes("mail") ? "mail" : "inbox"
          }
        : {}),
      sources: stepSources(raw.input, known)
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
export function toWorkflow(
  asset: Pick<Asset, "name" | "config" | "publishedRevision">,
  {
    revisionId,
    refusedFor = [],
    mayStart = false,
    startForm = NO_START_FORM,
    runsAs
  }: WorkflowListed = {},
  /** The asset's own pointers. The instance names a draft only to who may read it. */
  pointers: Pick<Asset, "draftRevision" | "publishedRevision" | "publishQuestion"> = {}
): WorkflowView {
  const definition = asset.config;
  const description = text(definition.description);
  const triggerId = records(definition.steps)
    .filter((step) => step.type === "trigger")
    .map((step) => text(step.id))[0];
  const steps = readSteps(definition.steps, {
    names: stepNames(definition.steps),
    triggerId,
    loops: new Map()
  });
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
            ...(pointers.publishedRevision === undefined
              ? {}
              : { publishedRevision: pointers.publishedRevision })
          }
        })
  };
}
