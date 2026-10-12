import type {
  JsonObject,
  JsonValue,
  WorkflowInputMapping,
  WorkflowReference,
  WorkflowRun,
  WorkflowRunsStore,
  WorkflowStepRun
} from "@vivd-catalyst/core";
import type { WorkflowStepIndex } from "./definition";
import { WORKFLOW_ITERATION_LABEL_MAX_CHARS } from "./limits";
import { WorkflowStepFailure } from "./step-failure";

// How a step reads what earlier steps left: a reference names a step and a dotted path into
// its output. A mapping holds literals and references and no expression.

/** The field a dotted path names. A segment is a key of an object or an index of a list. */
function fieldAt(value: JsonValue, path: string): { found: boolean; value: JsonValue } {
  let current = value;
  for (const segment of path === "" ? [] : path.split(".")) {
    if (Array.isArray(current)) {
      const item = /^(?:0|[1-9][0-9]*)$/u.test(segment) ? current[Number(segment)] : undefined;
      if (item === undefined) return { found: false, value: null };
      current = item;
    } else if (current !== null && typeof current === "object") {
      const field = Object.hasOwn(current, segment) ? current[segment] : undefined;
      if (field === undefined) return { found: false, value: null };
      current = field;
    } else {
      return { found: false, value: null };
    }
  }
  return { found: true, value: current };
}

/**
 * What the field of an item at a dotted path says to a person, where it is a text or a number.
 * Anything else, and a path the item does not have, labels nothing.
 */
export function itemLabelOf(item: JsonValue, path: string): string | undefined {
  const { value } = fieldAt(item, path);
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const label = String(value).trim();
  return label === "" ? undefined : label.slice(0, WORKFLOW_ITERATION_LABEL_MAX_CHARS);
}

function unresolved(reference: WorkflowReference, why: string): WorkflowStepFailure {
  const named = reference.path === "" ? reference.step : `${reference.step}.${reference.path}`;
  return new WorkflowStepFailure(
    "reference_unresolved",
    `The reference '${named}' does not resolve: ${why}`
  );
}

export interface ReferenceScope {
  store: WorkflowRunsStore;
  index: WorkflowStepIndex;
  run: WorkflowRun;
  /** The step run that reads. A reference is resolved from its place in the run. */
  stepRun: WorkflowStepRun;
}

/**
 * The value a reference names, read from the place of the step run that asks. A step of the
 * same sequence answers with the output of its run in the same iteration, a loop around the
 * step with its current item, and a step further out with the output of its run there.
 */
export async function resolveReference(
  scope: ReferenceScope,
  reference: WorkflowReference
): Promise<JsonValue> {
  const { store, run } = scope;
  const { clientInstanceId } = run;
  let sequence = scope.index.get(scope.stepRun.stepId)?.sequence;
  let parentStepRunId = scope.stepRun.parentStepRunId;
  let iteration = scope.stepRun.iteration;
  while (sequence) {
    if (sequence.steps.some((step) => step.id === reference.step)) {
      const output = await store.findStepOutput({
        clientInstanceId,
        runId: run.id,
        stepId: reference.step,
        ...(parentStepRunId === undefined ? {} : { parentStepRunId, iteration: iteration ?? 0 })
      });
      if (!output) throw unresolved(reference, "the step has no output");
      const field = fieldAt(output.value, reference.path);
      if (!field.found) throw unresolved(reference, "the output has no such field");
      return field.value;
    }
    if (parentStepRunId === undefined) break;
    if (sequence.loop === reference.step) {
      const item = await store.readLoopItem({
        clientInstanceId,
        id: parentStepRunId,
        index: iteration ?? 0
      });
      if (!item) throw unresolved(reference, "the loop has no such item");
      const field = fieldAt(item.value, reference.path);
      if (!field.found) throw unresolved(reference, "the item has no such field");
      return field.value;
    }
    const loopRun = await store.getStepRun({ clientInstanceId, id: parentStepRunId });
    sequence = sequence.parent;
    parentStepRunId = loopRun?.parentStepRunId;
    iteration = loopRun?.iteration;
  }
  throw unresolved(reference, "no step of that id ran before this one");
}

/** The input of a step: each field of its mapping as a literal or as what a reference names. */
export async function resolveInput(
  scope: ReferenceScope,
  mapping: WorkflowInputMapping
): Promise<JsonObject> {
  const input: JsonObject = {};
  for (const [field, source] of Object.entries(mapping)) {
    input[field] = "ref" in source ? await resolveReference(scope, source.ref) : source.value;
  }
  return input;
}
