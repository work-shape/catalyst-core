import { z } from "zod";
import type { JsonValue } from "./json";
import { WORKFLOW_ERROR_CODES, WORKFLOW_STEP_TYPES, type WorkflowStep } from "./workflows";

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
    | typeof WORKFLOW_ERROR_CODES.duplicateStepId
    | typeof WORKFLOW_ERROR_CODES.notSupported;
  /** The step the issue is at. */
  step: string;
  message: string;
}

/**
 * A step as the check reads it: a definition is checked before or beside its schema, so a
 * type no release knows and a field that is missing must be answered and never thrown on.
 */
type ReadStep = { id: string; type: string } & Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stepsOf = (value: unknown): ReadStep[] =>
  Array.isArray(value)
    ? value.filter(
        (step): step is ReadStep =>
          isRecord(step) && typeof step.id === "string" && typeof step.type === "string"
      )
    : [];

const BLOCK_TYPES: readonly string[] = ["loop", "condition", "parallel"];

/**
 * The lists of steps a block holds. A step of any other type holds none. A block is one level
 * whatever it holds, so the depth is asked of the type and not of these lists: a `parallel`
 * without a branch is as deep as one with ten.
 */
function listsOf(step: ReadStep): ReadStep[][] {
  if (step.type === "loop") return [stepsOf(step.steps)];
  if (step.type === "condition") return [stepsOf(step.then), stepsOf(step.else)];
  if (step.type === "parallel" && Array.isArray(step.branches)) {
    return step.branches.map((branch) => stepsOf(isRecord(branch) ? branch.steps : undefined));
  }
  return [];
}

const referenceOf = (value: unknown): string[] =>
  isRecord(value) && typeof value.step === "string" ? [value.step] : [];

const mappedReferences = (values: unknown): string[] =>
  (Array.isArray(values) ? values : isRecord(values) ? Object.values(values) : []).flatMap(
    (value) => (isRecord(value) ? referenceOf(value.ref) : [])
  );

/**
 * The ids of the steps a step references itself, without those of the steps it holds and
 * without the `collect` of a loop, which reads into the loop.
 */
function referencesOf(step: ReadStep): string[] {
  return [
    ...mappedReferences(step.input),
    ...mappedReferences(step.key),
    ...(step.type === "loop" ? referenceOf(step.items) : []),
    ...(step.type === "condition" && isRecord(step.when) ? referenceOf(step.when.ref) : [])
  ];
}

/**
 * What the nesting of a definition's blocks refuses. It never throws, whatever it is given.
 *
 * A step references the steps before it in its own list and in the lists that contain it, and
 * the loop it is in, whose id names the current item. A reference to any other step of the
 * definition is `reference_out_of_scope`: into a block from outside, into a sibling branch, or
 * to a step that comes later. The `collect` of a loop reads the loop's last step and no other.
 * A reference to an id no step has is not judged here.
 *
 * An id two steps have is `duplicate_step_id` at the second, and a reference to such an id is
 * `reference_out_of_scope`, since it names no one step. A block deeper than
 * `WORKFLOW_MAX_BLOCK_DEPTH` is `block_depth` and is not read further, so its steps count for
 * nothing. A step whose type is not in `WORKFLOW_STEP_TYPES` is `not_supported_yet`: the
 * reserved `condition` and `parallel`, and a type no release knows.
 */
export function workflowBlockIssues(steps: readonly WorkflowStep[]): WorkflowBlockIssue[] {
  const known: readonly string[] = WORKFLOW_STEP_TYPES;
  const issues: WorkflowBlockIssue[] = [];
  const all = new Set<string>();
  const duplicate = new Set<string>();
  const issue = (code: WorkflowBlockIssue["code"], step: ReadStep, message: string) =>
    issues.push({ code, step: step.id, message: `${message} (${code})` });

  // Both walks stop at the depth before they go down, so neither recurses deeper than it.
  const within = (depth: number) => depth + 1 <= WORKFLOW_MAX_BLOCK_DEPTH;

  const nesting = (list: ReadStep[], depth: number) => {
    for (const step of list) {
      if (all.has(step.id)) {
        duplicate.add(step.id);
        issue("duplicate_step_id", step, `The step id '${step.id}' is used more than once`);
      }
      all.add(step.id);
      if (!known.includes(step.type)) {
        issue(
          "not_supported_yet",
          step,
          `Step '${step.id}' has the type '${step.type}', which is not supported yet`
        );
      }
      if (!BLOCK_TYPES.includes(step.type)) continue;
      if (within(depth)) for (const inner of listsOf(step)) nesting(inner, depth + 1);
      else {
        issue(
          "block_depth",
          step,
          `Step '${step.id}' is nested deeper than ${String(WORKFLOW_MAX_BLOCK_DEPTH)} blocks`
        );
      }
    }
  };

  const check = (step: ReadStep, reference: string, sees: (id: string) => boolean) => {
    if (!all.has(reference)) return;
    if (duplicate.has(reference)) {
      issue(
        "reference_out_of_scope",
        step,
        `Step '${step.id}' references the step id '${reference}', which more than one step has`
      );
    } else if (!sees(reference)) {
      issue(
        "reference_out_of_scope",
        step,
        `Step '${step.id}' references step '${reference}', which it does not see from its place`
      );
    }
  };

  const references = (list: ReadStep[], inherited: ReadonlySet<string>, depth: number) => {
    const visible = new Set(inherited);
    for (const step of list) {
      for (const reference of referencesOf(step)) check(step, reference, (id) => visible.has(id));
      const lists = listsOf(step);
      if (step.type === "loop") {
        const last = lists[0]?.at(-1)?.id;
        for (const reference of referenceOf(step.collect)) {
          check(step, reference, (id) => id === last);
        }
      }
      if (lists.length > 0 && within(depth)) {
        // Inside a loop its id names the current item. A condition or parallel has no output
        // until it has ended, so its own steps do not see it.
        const inner = step.type === "loop" ? new Set([...visible, step.id]) : visible;
        for (const held of lists) references(held, inner, depth + 1);
      }
      visible.add(step.id);
    }
  };

  const top = stepsOf(steps);
  nesting(top, 0);
  references(top, new Set(), 0);
  return issues;
}
