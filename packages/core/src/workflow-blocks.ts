import { z } from "zod";
import type { JsonValue } from "./json";
import {
  WORKFLOW_ERROR_CODES,
  type WorkflowInputValue,
  type WorkflowReference,
  type WorkflowStep
} from "./workflows";

/** The step types that are reserved and that no engine of this release runs. */
export const WORKFLOW_RESERVED_STEP_TYPES = ["condition", "parallel"] as const;

/** What leaves a `condition`: which branch ran and the output of that branch's last step. */
export interface WorkflowConditionOutput {
  taken: "then" | "else";
  result: JsonValue;
}

/** What leaves a `parallel`: one field per branch id, the output of that branch's last step. */
export type WorkflowParallelOutput = Readonly<Record<string, JsonValue>>;

/**
 * How deep blocks nest: a `loop`, `condition` or `parallel` counts one level, in any
 * combination. A deeper definition is refused with `WORKFLOW_ERROR_CODES.blockDepth`.
 */
export const WORKFLOW_MAX_BLOCK_DEPTH = 16;

/**
 * Reserved in a Workflow's folder for positions and collapsed blocks by step id. No position
 * is stored today: the layout is computed. Neither the engine nor validation reads the file,
 * and it is not part of what a run pins.
 */
export const WORKFLOW_LAYOUT_FILE = "layout.yaml";

/**
 * On the step run of a `loop` or `parallel` step: how the step runs of each step directly
 * inside it stand, by step id. The canvas draws them on each node in the frame, so it reads
 * no step run of an item for them.
 */
export const workflowBodyCountsSchema = z.record(
  z.string(),
  z.strictObject({
    total: z.number().int().nonnegative(),
    done: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    running: z.number().int().nonnegative()
  })
);

export type WorkflowBodyCounts = z.infer<typeof workflowBodyCountsSchema>;

/** What the step run of a block carries for the run view. Missing on every other step run. */
export interface WorkflowBlockStepRunView {
  bodyCounts?: WorkflowBodyCounts;
}

/** One refusal of a definition for how its blocks nest or what a step in them references. */
export interface WorkflowBlockIssue {
  code:
    | typeof WORKFLOW_ERROR_CODES.blockDepth
    | typeof WORKFLOW_ERROR_CODES.referenceOutOfScope
    | typeof WORKFLOW_ERROR_CODES.notSupported;
  /** The step the issue is at. */
  step: string;
  message: string;
}

/** The lists of steps a block holds, each with the name its step runs carry as `branch`. */
function listsOf(step: WorkflowStep): readonly (readonly WorkflowStep[])[] {
  if (step.type === "loop") return [step.steps];
  if (step.type === "condition") return [step.then, ...(step.else ? [step.else] : [])];
  if (step.type === "parallel") return step.branches.map((branch) => branch.steps);
  return [];
}

const refsOf = (values: readonly WorkflowInputValue[]): WorkflowReference[] =>
  values.flatMap((value) => (value.ref ? [value.ref] : []));

/**
 * Every reference a step makes itself, without those of the steps it holds and without the
 * `collect` of a loop, which reads into the loop.
 */
function referencesOf(step: WorkflowStep): WorkflowReference[] {
  switch (step.type) {
    case "trigger":
    case "parallel":
      return [];
    case "loop":
      return [step.items];
    case "condition":
      return [step.when.ref];
    case "workflow":
      return [...refsOf(Object.values(step.input)), ...refsOf(step.key ?? [])];
    default:
      return refsOf(Object.values(step.input));
  }
}

function everyStepId(steps: readonly WorkflowStep[], into = new Set<string>()): Set<string> {
  for (const step of steps) {
    into.add(step.id);
    for (const list of listsOf(step)) everyStepId(list, into);
  }
  return into;
}

/**
 * What the nesting of a definition's blocks refuses. A step references the steps before it in
 * its own list and in the lists that contain it, and the loop it is in, whose id names the
 * current item. A reference to any other step of the definition is `reference_out_of_scope`:
 * into a block from outside, into a sibling branch, or to a step that comes later. The
 * `collect` of a loop alone reads into the loop's own steps. A reference to an id no step has
 * is not judged here. A block deeper than `WORKFLOW_MAX_BLOCK_DEPTH` is `block_depth` and is
 * not read further. `condition` and `parallel` are `not_supported_yet` until an engine runs them.
 */
export function workflowBlockIssues(steps: readonly WorkflowStep[]): WorkflowBlockIssue[] {
  const all = everyStepId(steps);
  const issues: WorkflowBlockIssue[] = [];
  const reserved: readonly string[] = WORKFLOW_RESERVED_STEP_TYPES;

  const walk = (list: readonly WorkflowStep[], inherited: ReadonlySet<string>, depth: number) => {
    const visible = new Set(inherited);
    for (const step of list) {
      const lists = listsOf(step);
      if (reserved.includes(step.type)) {
        issues.push({
          code: WORKFLOW_ERROR_CODES.notSupported,
          step: step.id,
          message: `Step '${step.id}' has the type '${step.type}', which is not supported yet (not_supported_yet)`
        });
      }
      const outOfScope = (reference: WorkflowReference, seen: ReadonlySet<string>) => {
        if (!all.has(reference.step) || seen.has(reference.step)) return;
        issues.push({
          code: WORKFLOW_ERROR_CODES.referenceOutOfScope,
          step: step.id,
          message: `Step '${step.id}' references step '${reference.step}', which is not before it in its own list or in a list that contains it (reference_out_of_scope)`
        });
      };
      for (const reference of referencesOf(step)) outOfScope(reference, visible);
      if (step.type === "loop" && step.collect) {
        outOfScope(step.collect, new Set(step.steps.map((inner) => inner.id)));
      }
      if (lists.length > 0 && depth + 1 > WORKFLOW_MAX_BLOCK_DEPTH) {
        issues.push({
          code: WORKFLOW_ERROR_CODES.blockDepth,
          step: step.id,
          message: `Step '${step.id}' is nested deeper than ${String(WORKFLOW_MAX_BLOCK_DEPTH)} blocks (block_depth)`
        });
      } else {
        // Inside a loop its id names the current item. A condition or parallel has no output
        // until it has ended, so its own steps do not see it.
        const within = step.type === "loop" ? new Set([...visible, step.id]) : visible;
        for (const inner of lists) walk(inner, within, depth + 1);
      }
      visible.add(step.id);
    }
  };
  walk(steps, new Set(), 0);
  return issues;
}
