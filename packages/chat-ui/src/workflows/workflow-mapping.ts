import type { Asset } from "@vivd-catalyst/api-client";
import {
  CONNECTION_OPERATION_PREFIX,
  DATA_STORE_OPERATION_PREFIX,
  type WorkflowBlockStepRunView,
  type WorkflowLoopCounts,
  type WorkflowRunLineage,
  type WorkflowRunStatus,
  type WorkflowStepRunCall,
  type WorkflowStepRunLink,
  type WorkflowStepRunPlacement,
  type WorkflowStepRunStatus
} from "@vivd-catalyst/core";
import type {
  WorkflowBranchView,
  WorkflowFailureReason,
  WorkflowListItem,
  WorkflowOutputPreview,
  WorkflowRunView,
  WorkflowStepKind,
  WorkflowStepRunView,
  WorkflowStepSource,
  WorkflowStepView,
  WorkflowUnsupported,
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
  operation_not_found: "operationMissing",
  operation_input_invalid: "dataMismatch",
  reference_unresolved: "dataMismatch",
  loop_items_not_a_list: "dataMismatch",
  output_not_json: "dataMismatch",
  output_invalid: "outputInvalid",
  step_data_too_large: "tooMuchData",
  loop_too_long: "tooMuchData",
  dataset_limit: "tooMuchData",
  step_type_not_executed: "notSupported",
  not_supported_yet: "notSupported",
  operation_interrupted: "interrupted",
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

/**
 * A run as the engine's read answers it: the fields the screens read, with the names of the
 * run view of the contract. The engine's slice maps its resource onto this.
 */
export interface WorkflowRunResource extends TimesResource, Partial<OnTheWire<WorkflowRunLineage>> {
  id: string;
  workflow: string;
  trigger: "manual" | "schedule" | "parent";
  status: WorkflowRunStatus;
  startedBy: { id: string; label: string };
  /** On a child run: the id of the Workflow of the run that started it. */
  parentWorkflow?: string;
  /** The revision of the definition the run started on. */
  definitionRevisionId?: string;
  error?: ErrorResource;
  outputPreview?: WorkflowOutputPreview;
  /** When someone asked to cancel the run. It ends when the call that is going has ended. */
  cancelledAt?: string;
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
}

function toFailure(error: ErrorResource | undefined) {
  return error === undefined
    ? {}
    : {
        failure: {
          reason: FAILURE_REASONS[error.code] ?? "other",
          detail: error.message,
          ...(error.action === undefined ? {} : { action: error.action })
        }
      };
}

function toOutput(preview: WorkflowOutputPreview | undefined) {
  return preview === undefined
    ? {}
    : { output: { text: preview.text, truncated: preview.truncated } };
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
    ...(run.definitionRevisionId === undefined ? {} : { revisionId: run.definitionRevisionId }),
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
    ...(childRunId === undefined ? {} : { childRunId }),
    ...times(stepRun),
    ...toFailure(stepRun.error),
    ...toOutput(stepRun.outputPreview)
  };
}

/** A Workflow as the engine's list names it: what has a published definition. */
export interface WorkflowSummaryResource {
  id: string;
  name: string;
  description?: string;
  /** The latest run of the Workflow, where it has one. */
  lastRun?: { id: string; status: WorkflowRunStatus; startedAt?: string };
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
    ...(lastRun === undefined
      ? {}
      : {
          lastRun: {
            id: lastRun.id,
            status: lastRun.status,
            ...(lastRun.startedAt === undefined ? {} : { startedAt: lastRun.startedAt })
          }
        })
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

/** The id of a step as a name, for a step whose definition gives none. */
function stepNameFromId(id: string): string {
  const words = id.replace(/[_-]+/gu, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
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
      sources.push({ from: "step", name: known.names.get(step) ?? stepNameFromId(step) });
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
      name: text(raw.name) ?? stepNameFromId(id),
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
      ...(kind === "notify" ? { channel: raw.channel === "mail" ? "mail" : "inbox" } : {}),
      sources: stepSources(raw.input, known)
    });
  }
  return steps;
}

function stepNames(value: unknown, names = new Map<string, string>()): Map<string, string> {
  for (const raw of records(value)) {
    const id = text(raw.id);
    if (id !== undefined) {
      names.set(id, text(raw.name) ?? stepNameFromId(id));
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
  /**
   * The id of the published revision, which a run names as the one it started on. The read of
   * an asset answers the revision's number and not its id, so the instance cannot give it yet.
   */
  revisionId?: string,
  /** What the engine of the instance does not run of this definition. See `engine-limits`. */
  unsupported: readonly WorkflowUnsupported[] = []
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
  const inputs = isRecord(definition.inputs) ? definition.inputs : {};
  return {
    id: asset.name,
    name: text(definition.name) ?? asset.name,
    ...(description === undefined ? {} : { description }),
    published: asset.publishedRevision !== undefined,
    ...(revisionId === undefined ? {} : { revisionId }),
    steps,
    startsByHand: steps.some((step) => step.starts?.byHand === true),
    needsInput:
      (isRecord(inputs.properties) && Object.keys(inputs.properties).length > 0) ||
      (Array.isArray(inputs.required) && inputs.required.length > 0),
    unsupported
  };
}
