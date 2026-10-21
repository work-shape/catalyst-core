// Editing a Workflow by hand is a list of step operations on its draft (workflow-canvas 9.4,
// decision 5): each names a step by its id and what it does to it. One pure function applies
// them to a manifest; another applies them again to a draft the agent saved meanwhile
// (decision 6). Neither knows a form: the Settings tab makes the operations, the page saves.

/** A step's fields as the manifest holds them: any key but its id and its type. */
type StepFields = Readonly<Record<string, unknown>>;

/**
 * One operation on a step. `set` gives fields their new value, and `undefined` takes a field
 * away. Adding, deleting and moving steps are WF-EDIT-4's.
 */
export interface StepEdit {
  kind: "set";
  step: string;
  fields: StepFields;
}

/**
 * The step a Workflow's own fields are named by in an edit, such as `outputs`, which the
 * result step's values write. No step id has a `$`.
 */
export const WORKFLOW_FIELDS = "$workflow";

/** The fields of the Workflow itself an edit never sets. */
const FIXED_WORKFLOW_FIELDS: ReadonlySet<string> = new Set(["id", "steps"]);

/** `workflow.yaml` as the asset holds it under `manifest`. */
export type WorkflowManifest = Readonly<Record<string, unknown>>;

/**
 * The field a code step's script is edited as (WF-EDIT-2): the text of the file the step
 * names, which the config holds under `files` and not in the manifest. A field whose name
 * starts with `$` is never a key of a step.
 */
export const SCRIPT_FIELD = "$script";

/** One file of the Workflow's folder as the config holds it. */
export interface WorkflowFile {
  path: string;
  content: string;
}

/** Where the step files of a Workflow stand in its folder (`WORKFLOW_STEP_FILES_FOLDER`). */
const STEP_FILES_FOLDER = "steps";

/** The files of a config, where it holds any. */
export function workflowFiles(config: unknown): WorkflowFile[] {
  const files = isRecord(config) && Array.isArray(config.files) ? config.files : [];
  return files.flatMap((file) =>
    isRecord(file) && typeof file.path === "string" && typeof file.content === "string"
      ? [{ path: file.path, content: file.content }]
      : []
  );
}

/** The path of a code step's script in the Workflow's folder. */
function scriptPath(step: Readonly<Record<string, unknown>> | undefined): string | undefined {
  return step?.type === "code" && typeof step.file === "string" && step.file !== ""
    ? `${STEP_FILES_FOLDER}/${step.file}`
    : undefined;
}

/** The value of one field of a step, the script of a code step among them. */
export function stepValue(
  manifest: WorkflowManifest,
  files: readonly WorkflowFile[],
  stepId: string,
  field: string
): unknown {
  const step = findStep(manifest, stepId);
  if (field !== SCRIPT_FIELD) return step?.[field];
  const path = scriptPath(step);
  return path === undefined ? undefined : files.find((file) => file.path === path)?.content;
}

/**
 * The files with the scripts the operations set, after `applyStepEdits` made `manifest`. A
 * script whose file is not there yet is added; nothing else of the folder changes.
 */
export function applyFileEdits(
  manifest: WorkflowManifest,
  files: readonly WorkflowFile[],
  edits: readonly StepEdit[]
): WorkflowFile[] {
  const next = [...files];
  for (const edit of edits) {
    if (!Object.hasOwn(edit.fields, SCRIPT_FIELD)) continue;
    const path = scriptPath(findStep(manifest, edit.step));
    const content = edit.fields[SCRIPT_FIELD];
    if (path === undefined || typeof content !== "string") continue;
    const at = next.findIndex((file) => file.path === path);
    if (at === -1) next.push({ path, content });
    else next[at] = { path, content };
  }
  return next;
}

/** The fields an edit never sets: the server names a step by them. */
const FIXED_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "type",
  "steps",
  "branches",
  "then",
  "else"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether two values of a manifest say the same, whatever order their keys stand in. */
export function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameValue(item, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const keys = (record: Record<string, unknown>) =>
    Object.keys(record).filter((key) => record[key] !== undefined);
  const leftKeys = keys(left);
  return (
    leftKeys.length === keys(right).length &&
    leftKeys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
  );
}

/** The step lists a step holds: a loop's body and the paths of a condition or parallel step. */
function innerLists(step: Record<string, unknown>): unknown[][] {
  const lists: unknown[][] = [];
  if (Array.isArray(step.steps)) lists.push(step.steps);
  if (Array.isArray(step.branches)) {
    for (const branch of step.branches) {
      if (isRecord(branch) && Array.isArray(branch.steps)) lists.push(branch.steps);
    }
  }
  if (Array.isArray(step.then)) lists.push(step.then);
  if (Array.isArray(step.else)) lists.push(step.else);
  return lists;
}

/** The step with this id, at any depth of the manifest; `WORKFLOW_FIELDS` is the manifest. */
export function findStep(
  manifest: WorkflowManifest,
  id: string
): Readonly<Record<string, unknown>> | undefined {
  if (id === WORKFLOW_FIELDS) return manifest;
  const walk = (list: unknown): Record<string, unknown> | undefined => {
    if (!Array.isArray(list)) return undefined;
    for (const step of list) {
      if (!isRecord(step)) continue;
      if (step.id === id) return step;
      for (const inner of innerLists(step)) {
        const found = walk(inner);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  return walk(manifest.steps);
}

/** A copy of a step list with one step replaced, at any depth. */
function replaced(
  list: unknown,
  id: string,
  change: (step: Record<string, unknown>) => Record<string, unknown>
): unknown {
  if (!Array.isArray(list)) return list;
  return list.map((step) => {
    if (!isRecord(step)) return step;
    if (step.id === id) return change(step);
    let next = step;
    for (const key of ["steps", "then", "else"] as const) {
      if (Array.isArray(step[key])) next = { ...next, [key]: replaced(step[key], id, change) };
    }
    if (Array.isArray(step.branches)) {
      next = {
        ...next,
        branches: step.branches.map((branch) =>
          isRecord(branch) ? { ...branch, steps: replaced(branch.steps, id, change) } : branch
        )
      };
    }
    return next;
  });
}

/**
 * The manifest with the operations applied, in their order. An operation on a step the
 * manifest does not hold does nothing; `rebaseStepEdits` says which those are.
 */
export function applyStepEdits(
  manifest: WorkflowManifest,
  edits: readonly StepEdit[]
): WorkflowManifest {
  let next: WorkflowManifest = manifest;
  for (const edit of edits) {
    if (edit.step === WORKFLOW_FIELDS) {
      const changed: Record<string, unknown> = { ...next };
      for (const [field, value] of Object.entries(edit.fields)) {
        if (FIXED_WORKFLOW_FIELDS.has(field) || field.startsWith("$")) continue;
        if (value === undefined) delete changed[field];
        else changed[field] = value;
      }
      next = changed;
      continue;
    }
    next = {
      ...next,
      steps: replaced(next.steps, edit.step, (step) => {
        const changed: Record<string, unknown> = { ...step };
        for (const [field, value] of Object.entries(edit.fields)) {
          if (FIXED_FIELDS.has(field) || field.startsWith("$")) continue;
          if (value === undefined) delete changed[field];
          else changed[field] = value;
        }
        return changed;
      })
    };
  }
  return next;
}

/** A field the agent changed while a person changed it too. */
export interface EditConflict {
  step: string;
  field: string;
  /** What the agent saved, which the person's value stands over. */
  theirs: unknown;
}

/** Operations made on one draft, carried over onto the draft that replaced it. */
export interface RebasedEdits {
  /** The operations on the new draft: those whose step is still there. */
  edits: StepEdit[];
  /**
   * Fields the agent changed as well. The person's value stands; the agent's is shown under
   * the field. Where there are none, the edits are saved again without a question.
   */
  conflicts: EditConflict[];
  /** The steps the agent deleted: what was changed on them is dropped. */
  dropped: string[];
}

/**
 * Carries operations made on the draft `base` over to `latest`, which another writer saved
 * meanwhile (decision 6). A field the other writer left as it was in `base` takes the person's
 * value without a question; one it changed keeps the person's value and is named as a
 * conflict; an operation on a step `latest` no longer holds is dropped.
 */
export function rebaseStepEdits(input: {
  base: WorkflowManifest;
  latest: WorkflowManifest;
  edits: readonly StepEdit[];
  /** The files of each draft, for a script the operations set. */
  baseFiles?: readonly WorkflowFile[];
  latestFiles?: readonly WorkflowFile[];
}): RebasedEdits {
  const edits: StepEdit[] = [];
  const conflicts: EditConflict[] = [];
  const dropped: string[] = [];
  for (const edit of input.edits) {
    const now = findStep(input.latest, edit.step);
    if (now === undefined) {
      if (!dropped.includes(edit.step)) dropped.push(edit.step);
      continue;
    }
    for (const field of Object.keys(edit.fields)) {
      const before = stepValue(input.base, input.baseFiles ?? [], edit.step, field);
      const theirs = stepValue(input.latest, input.latestFiles ?? [], edit.step, field);
      if (!sameValue(before, theirs) && !sameValue(edit.fields[field], theirs)) {
        conflicts.push({ step: edit.step, field, theirs });
      }
    }
    edits.push(edit);
  }
  return { edits, conflicts, dropped };
}

/** The edits with the fields of one step taken together: the last value of a field stands. */
function mergedEdits(edits: readonly StepEdit[]): StepEdit[] {
  const byStep = new Map<string, Record<string, unknown>>();
  for (const edit of edits) {
    byStep.set(edit.step, { ...byStep.get(edit.step), ...edit.fields });
  }
  return [...byStep].map(([step, fields]) => ({ kind: "set", step, fields }));
}

/**
 * The edits less every field that already says what the manifest says: what a form holds
 * that is no change. An edit with no field left is left out.
 */
export function effectiveEdits(
  manifest: WorkflowManifest,
  edits: readonly StepEdit[],
  files: readonly WorkflowFile[] = []
): StepEdit[] {
  return mergedEdits(edits).flatMap((edit) => {
    const fields = Object.fromEntries(
      Object.entries(edit.fields).filter(
        ([field, value]) => !sameValue(stepValue(manifest, files, edit.step, field), value)
      )
    );
    return Object.keys(fields).length === 0 ? [] : [{ ...edit, fields }];
  });
}
