import {
  workflowDurationMs,
  type WorkflowLimits,
  type WorkflowManifest,
  type WorkflowRunBounds
} from "@work-shape/catalyst-core";
import { WORKFLOW_LIMIT_ABOVE_CEILING, type WorkflowDefinitionIssue } from "./definition";
import {
  WORKFLOW_DATASET_MAX_BYTES,
  WORKFLOW_PAGED_STEP_MAX_MINUTES,
  WORKFLOW_RUN_LIMITS,
  defaultWorkflowConcurrency,
  type WorkflowLimitCeilings,
  type WorkflowRunLimits
} from "./limits";

// The `limits` of a Workflow against the release: what a publish refuses because it lies above
// an operator's ceiling, what the publish question names because it raises a default, and the
// bounds a run is opened under.

const MINUTE = 60 * 1_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A length of time as `workflow.yaml` writes it: days from a week up, hours, or minutes. */
export function workflowDurationText(ms: number): string {
  if (ms >= 7 * DAY && ms % DAY === 0) return `${String(ms / DAY)}d`;
  if (ms % HOUR === 0) return `${String(ms / HOUR)}h`;
  return `${String(Math.ceil(ms / MINUTE))}m`;
}

/** The release's instance, as the checks of a Workflow's limits read it. */
export interface WorkflowLimitContext {
  ceilings: WorkflowLimitCeilings;
  /** The step slots of a process, which bound `limits.concurrency`. */
  stepSlots: number;
  /** The defaults. The release's constants unless a test lowers them. */
  defaults?: WorkflowRunLimits;
}

interface LimitEntry {
  field: keyof WorkflowLimits;
  /** What a sentence calls it. */
  label: string;
  asked: number | undefined;
  /** As the Workflow wrote it, where it wrote it. */
  text: string | undefined;
  standard: number;
  ceiling: number;
  show(value: number): string;
}

function entriesOf(limits: WorkflowLimits, context: WorkflowLimitContext): LimitEntry[] {
  const defaults = context.defaults ?? WORKFLOW_RUN_LIMITS;
  const { ceilings } = context;
  const count = (value: number) => value.toLocaleString("en");
  return [
    {
      field: "duration",
      label: "run time",
      asked: limits.duration === undefined ? undefined : workflowDurationMs(limits.duration),
      text: limits.duration,
      standard: defaults.maxDurationMs,
      ceiling: ceilings.durationMs,
      show: workflowDurationText
    },
    {
      field: "stepRuns",
      label: "step runs per run",
      asked: limits.stepRuns,
      text: undefined,
      standard: defaults.maxStepRuns,
      ceiling: ceilings.stepRuns,
      show: count
    },
    {
      field: "loopItems",
      label: "items per loop",
      asked: limits.loopItems,
      text: undefined,
      standard: defaults.loopMaxItems,
      ceiling: ceilings.loopItems,
      show: count
    },
    {
      field: "concurrency",
      label: "step slots of the Workflow",
      asked: limits.concurrency,
      text: undefined,
      standard: defaultWorkflowConcurrency(context.stepSlots),
      ceiling: context.stepSlots,
      show: count
    },
    {
      field: "datasetBytes",
      label: "dataset bytes",
      asked: limits.datasetBytes,
      text: undefined,
      standard: WORKFLOW_DATASET_MAX_BYTES,
      ceiling: Math.min(ceilings.datasetBytes, WORKFLOW_DATASET_MAX_BYTES),
      show: count
    },
    {
      field: "pagedStepMinutes",
      label: "minutes of a paged step",
      asked: limits.pagedStepMinutes,
      text: undefined,
      standard: WORKFLOW_PAGED_STEP_MAX_MINUTES,
      ceiling: ceilings.pagedStepMinutes,
      show: count
    }
  ];
}

/**
 * What a publish refuses of a Workflow's `limits`: each value above the ceiling of release
 * config, naming the ceiling. Empty for a Workflow within them. `datasetBytes` above its
 * default is still refused by the definition's parser.
 */
export function workflowLimitIssues(
  manifest: Pick<WorkflowManifest, "limits">,
  context: WorkflowLimitContext
): WorkflowDefinitionIssue[] {
  if (!manifest.limits) return [];
  return entriesOf(manifest.limits, context).flatMap((entry) =>
    entry.asked !== undefined && entry.asked > entry.ceiling
      ? [
          {
            path: `limits.${entry.field}`,
            code: WORKFLOW_LIMIT_ABOVE_CEILING,
            message: `The ${entry.label} of ${entry.text ?? entry.show(entry.asked)} is above the ceiling of ${entry.show(entry.ceiling)} that this instance allows`
          }
        ]
      : []
  );
}

/** One limit a Workflow raises above its default: what the publish question names. */
export interface WorkflowLimitRaise {
  field: keyof WorkflowLimits;
  /** The default, in the unit of the field: milliseconds for `duration`. */
  standard: number;
  asked: number;
  /** As the Workflow wrote it, where it wrote it, such as `24h`. */
  text?: string;
}

/**
 * The limits a Workflow raises above their defaults, one per raise, for the publish question
 * to word. Empty where the Workflow keeps the defaults or lowers them.
 */
export function workflowLimitRaises(
  manifest: Pick<WorkflowManifest, "limits">,
  context: WorkflowLimitContext
): WorkflowLimitRaise[] {
  if (!manifest.limits) return [];
  return entriesOf(manifest.limits, context).flatMap((entry) =>
    entry.asked !== undefined && entry.asked > entry.standard
      ? [
          {
            field: entry.field,
            standard: entry.standard,
            asked: entry.asked,
            ...(entry.text === undefined ? {} : { text: entry.text })
          }
        ]
      : []
  );
}

/**
 * The bounds a run of this definition is opened under: its `limits` within the ceilings, the
 * defaults where it sets none. A child run counts against the slots of its root, so it takes
 * the concurrency its parent was opened under.
 */
export function workflowRunBounds(
  manifest: Pick<WorkflowManifest, "id" | "limits">,
  context: WorkflowLimitContext & { parent?: WorkflowRunBounds }
): WorkflowRunBounds {
  const limits = manifest.limits ?? {};
  const [duration, stepRuns, loopItems, concurrency] = entriesOf(limits, context).map((entry) =>
    Math.min(entry.asked ?? entry.standard, entry.ceiling)
  );
  const own = {
    key: `workflow:${manifest.id}`,
    slots: Math.max(1, concurrency ?? defaultWorkflowConcurrency(context.stepSlots))
  };
  const shared = context.parent ? context.parent.concurrency : own;
  return {
    durationMs: duration ?? WORKFLOW_RUN_LIMITS.maxDurationMs,
    stepRuns: stepRuns ?? WORKFLOW_RUN_LIMITS.maxStepRuns,
    loopItems: loopItems ?? WORKFLOW_RUN_LIMITS.loopMaxItems,
    ...(shared ? { concurrency: shared } : {})
  };
}
