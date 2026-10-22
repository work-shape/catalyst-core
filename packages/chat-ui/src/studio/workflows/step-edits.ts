// Editing a Workflow by hand is a list of step operations on its draft (workflow-canvas 9.4,
// decision 5): each names a step by its id and what it does to it. One pure function applies
// them to a manifest; another applies them again to a draft the agent saved meanwhile
// (decision 6). Neither knows a form: the Settings tab makes the operations, the page saves.

/** A step's fields as the manifest holds them: any key but its id and its type. */
type StepFields = Readonly<Record<string, unknown>>;

/**
 * A place in the step lists of a manifest: after a step in its list, or first or last in the
 * body of a loop or one path of a condition or a parallel block (`path` names the path).
 */
export type StepPlace =
  { kind: "after"; step: string } | { kind: "first" | "last"; block: string; path?: string };

/**
 * One operation on a step. `set` gives fields their new value, and `undefined` takes a field
 * away. `insert` puts a new step with this id and these fields (its `type` among them) at a
 * place; `delete` takes a step away with what it holds; `move` takes it to another place with
 * what it holds (workflow-canvas 9.6).
 */
export type StepEdit =
  | { kind: "set"; step: string; fields: StepFields }
  | { kind: "insert"; step: string; at: StepPlace; fields: StepFields }
  | { kind: "delete"; step: string }
  | { kind: "move"; step: string; at: StepPlace };

/** An operation saved at once, on its own: deleting or moving a step. */
export type StructureEdit = Extract<StepEdit, { kind: "delete" | "move" }>;

/** The fields an operation writes: those of a `set` and those a new step starts with. */
const writtenFields = (edit: StepEdit): StepFields | undefined =>
  edit.kind === "set" || edit.kind === "insert" ? edit.fields : undefined;

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
    const fields = writtenFields(edit);
    if (fields === undefined || !Object.hasOwn(fields, SCRIPT_FIELD)) continue;
    const path = scriptPath(findStep(manifest, edit.step));
    const content = fields[SCRIPT_FIELD];
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

/** A step record's fields as an edit writes them: without the fixed ones and those of the form. */
function written(
  step: Record<string, unknown>,
  fields: StepFields,
  fixed: ReadonlySet<string>
): Record<string, unknown> {
  const changed: Record<string, unknown> = { ...step };
  for (const [field, value] of Object.entries(fields)) {
    if (fixed.has(field) || field.startsWith("$")) continue;
    if (value === undefined) delete changed[field];
    else changed[field] = value;
  }
  return changed;
}

/** A copy of a step list without the step of this id, at any depth, and the step taken. */
function without(list: unknown, id: string): { list: unknown; taken?: Record<string, unknown> } {
  if (!Array.isArray(list)) return { list };
  let taken: Record<string, unknown> | undefined;
  const at = list.findIndex((step) => isRecord(step) && step.id === id);
  if (at !== -1) {
    const found = list[at];
    return {
      list: list.filter((_, index) => index !== at),
      ...(isRecord(found) ? { taken: found } : {})
    };
  }
  const next = list.map((step) => {
    if (!isRecord(step) || taken !== undefined) return step;
    let changed = step;
    for (const key of ["steps", "then", "else"] as const) {
      if (taken !== undefined || !Array.isArray(step[key])) continue;
      const inner = without(step[key], id);
      if (inner.taken !== undefined) {
        taken = inner.taken;
        changed = { ...changed, [key]: inner.list };
      }
    }
    if (taken === undefined && Array.isArray(step.branches)) {
      changed = {
        ...changed,
        branches: step.branches.map((branch) => {
          if (taken !== undefined || !isRecord(branch)) return branch;
          const inner = without(branch.steps, id);
          if (inner.taken === undefined) return branch;
          taken = inner.taken;
          return { ...branch, steps: inner.list };
        })
      };
    }
    return taken === undefined ? step : changed;
  });
  return { list: next, ...(taken === undefined ? {} : { taken }) };
}

/** The list of a block a place names: a loop's body, or the path of a condition or parallel. */
function blockList(block: Record<string, unknown>, path: string | undefined): unknown {
  if (path === undefined) return block.steps;
  if (Array.isArray(block.branches)) {
    const branch = block.branches.find((entry) => isRecord(entry) && entry.id === path);
    return isRecord(branch) ? (branch.steps ?? []) : undefined;
  }
  return path === "then" || path === "else" ? (block[path] ?? []) : undefined;
}

/** The block with its list at `path` replaced. */
function withBlockList(
  block: Record<string, unknown>,
  path: string | undefined,
  list: unknown[]
): Record<string, unknown> {
  if (path === undefined) return { ...block, steps: list };
  if (Array.isArray(block.branches)) {
    return {
      ...block,
      branches: block.branches.map((branch) =>
        isRecord(branch) && branch.id === path ? { ...branch, steps: list } : branch
      )
    };
  }
  return { ...block, [path]: list };
}

/** Whether the manifest holds the place: the step or the block it names, and the path. */
function placeHeld(manifest: WorkflowManifest, at: StepPlace): boolean {
  if (at.kind === "after") return findStep(manifest, at.step) !== undefined;
  const block = findStep(manifest, at.block);
  return block !== undefined && Array.isArray(blockList({ ...block }, at.path));
}

/** A copy of the step lists with a step put at a place. Nothing changes where it is not held. */
function placed(manifest: WorkflowManifest, at: StepPlace, step: Record<string, unknown>) {
  if (!placeHeld(manifest, at)) return manifest;
  if (at.kind !== "after") {
    return {
      ...manifest,
      steps: replaced(manifest.steps, at.block, (block) => {
        const list = blockList(block, at.path);
        const items = Array.isArray(list) ? list : [];
        return withBlockList(
          block,
          at.path,
          at.kind === "first" ? [step, ...items] : [...items, step]
        );
      })
    };
  }
  const put = (list: unknown): unknown => {
    if (!Array.isArray(list)) return list;
    const index = list.findIndex((entry) => isRecord(entry) && entry.id === at.step);
    if (index !== -1) return [...list.slice(0, index + 1), step, ...list.slice(index + 1)];
    return list.map((entry) => {
      if (!isRecord(entry)) return entry;
      let next = entry;
      for (const key of ["steps", "then", "else"] as const) {
        if (Array.isArray(entry[key])) next = { ...next, [key]: put(entry[key]) };
      }
      if (Array.isArray(entry.branches)) {
        next = {
          ...next,
          branches: entry.branches.map((branch) =>
            isRecord(branch) ? { ...branch, steps: put(branch.steps) } : branch
          )
        };
      }
      return next;
    });
  };
  return { ...manifest, steps: put(manifest.steps) };
}

/** The ids of a step and of every step it holds. */
export function heldIds(step: Readonly<Record<string, unknown>>): string[] {
  const ids = typeof step.id === "string" ? [step.id] : [];
  for (const list of innerLists({ ...step })) {
    for (const inner of list) if (isRecord(inner)) ids.push(...heldIds(inner));
  }
  return ids;
}

/** The step a place lies at or in: the one it follows, or the block it is in. */
const placeAnchor = (at: StepPlace) => (at.kind === "after" ? at.step : at.block);

/**
 * The manifest with the operations applied, in their order. An operation on a step the
 * manifest does not hold, or at a place it does not hold, does nothing; `rebaseStepEdits` says
 * which those are. A step is never moved into itself, and a new step never takes an id that
 * is there already.
 */
export function applyStepEdits(
  manifest: WorkflowManifest,
  edits: readonly StepEdit[]
): WorkflowManifest {
  let next: WorkflowManifest = manifest;
  for (const edit of edits) {
    if (edit.step === WORKFLOW_FIELDS) {
      if (edit.kind === "set") next = written({ ...next }, edit.fields, FIXED_WORKFLOW_FIELDS);
      continue;
    }
    switch (edit.kind) {
      case "set":
        next = {
          ...next,
          steps: replaced(next.steps, edit.step, (step) => written(step, edit.fields, FIXED_FIELDS))
        };
        break;
      case "insert": {
        if (findStep(next, edit.step) !== undefined) break;
        const step = written({}, edit.fields, new Set(["id"]));
        next = placed(next, edit.at, { id: edit.step, ...step });
        break;
      }
      case "delete":
        next = { ...next, steps: without(next.steps, edit.step).list };
        break;
      case "move": {
        const step = findStep(next, edit.step);
        if (step === undefined || heldIds(step).includes(placeAnchor(edit.at))) break;
        const taken = without(next.steps, edit.step);
        const rest = { ...next, steps: taken.list };
        if (taken.taken === undefined || !placeHeld(rest, edit.at)) break;
        next = placed(rest, edit.at, taken.taken);
        break;
      }
    }
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
  const drop = (step: string) => {
    if (!dropped.includes(step)) dropped.push(step);
  };
  // The operations are carried over in their order: a step added earlier is there for the
  // operations after it.
  let now = input.latest;
  for (const edit of input.edits) {
    if (edit.kind === "insert" || edit.kind === "move") {
      if (
        !placeHeld(now, edit.at) ||
        (edit.kind === "move" && findStep(now, edit.step) === undefined)
      ) {
        drop(edit.step);
        continue;
      }
    } else if (findStep(now, edit.step) === undefined) {
      drop(edit.step);
      continue;
    }
    for (const field of Object.keys(edit.kind === "set" ? edit.fields : {})) {
      const before = stepValue(input.base, input.baseFiles ?? [], edit.step, field);
      const theirs = stepValue(input.latest, input.latestFiles ?? [], edit.step, field);
      if (
        edit.kind === "set" &&
        !sameValue(before, theirs) &&
        !sameValue(edit.fields[field], theirs)
      ) {
        conflicts.push({ step: edit.step, field, theirs });
      }
    }
    edits.push(edit);
    now = applyStepEdits(now, [edit]);
  }
  return { edits, conflicts, dropped };
}

/**
 * The edits with the fields of one step taken together, where its first `set` stands: the
 * last value of a field stands. Adding, deleting and moving keep their order.
 */
function mergedEdits(edits: readonly StepEdit[]): StepEdit[] {
  const merged: StepEdit[] = [];
  const setOf = new Map<string, { kind: "set"; step: string; fields: Record<string, unknown> }>();
  for (const edit of edits) {
    if (edit.kind !== "set") {
      merged.push(edit);
      // A step deleted, or added anew, takes no earlier field along.
      if (edit.kind === "delete" || edit.kind === "insert") setOf.delete(edit.step);
      continue;
    }
    const held = setOf.get(edit.step);
    if (held !== undefined) {
      Object.assign(held.fields, edit.fields);
      continue;
    }
    const entry = { kind: "set" as const, step: edit.step, fields: { ...edit.fields } };
    setOf.set(edit.step, entry);
    merged.push(entry);
  }
  return merged;
}

/**
 * The edits less every field that already says what the manifest says: what a form holds
 * that is no change. A `set` with no field left is left out; adding, deleting and moving are
 * always changes.
 */
export function effectiveEdits(
  manifest: WorkflowManifest,
  edits: readonly StepEdit[],
  files: readonly WorkflowFile[] = []
): StepEdit[] {
  const added = new Set(edits.flatMap((edit) => (edit.kind === "insert" ? [edit.step] : [])));
  return mergedEdits(edits).flatMap((edit) => {
    if (edit.kind !== "set" || added.has(edit.step)) return [edit];
    const fields = Object.fromEntries(
      Object.entries(edit.fields).filter(
        ([field, value]) => !sameValue(stepValue(manifest, files, edit.step, field), value)
      )
    );
    return Object.keys(fields).length === 0 ? [] : [{ ...edit, fields }];
  });
}

/** Ascii letters for the letters a name may hold beyond them, as a step id takes them. */
const SPELLED: Readonly<Record<string, string>> = { ä: "ae", ö: "oe", ü: "ue", ß: "ss" };

/**
 * A key from a name, as a person wrote it: lowercase ascii letters, digits, `_` and, where
 * `hyphen`, `-`, starting with a letter, at most 56 characters, `fallback` where the name
 * gives none, and with `_2`, `_3` … where it is one of `taken`.
 */
export function keyFrom(
  name: string,
  taken: ReadonlySet<string>,
  { fallback, hyphen }: { fallback: string; hyphen: boolean }
): string {
  const spelled = name
    .toLowerCase()
    .replace(/[äöüß]/gu, (letter) => SPELLED[letter] ?? letter)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "");
  const words = spelled
    .replace(hyphen ? /[^a-z0-9_-]+/gu : /[^a-z0-9_]+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^[^a-z]+/u, "")
    .replace(/[_-]+$/u, "")
    .slice(0, 56);
  const stem = words === "" ? fallback : words;
  if (!taken.has(stem)) return stem;
  for (let count = 2; ; count += 1) {
    const id = `${stem}_${String(count)}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * The id of a new step, from its name (workflow-canvas 9.4, decision 7): lowercase letters,
 * digits, `_` and `-`, starting with a letter, and not one of `taken`. It never changes, also
 * when the step is renamed.
 */
export function stepIdFrom(name: string, taken: ReadonlySet<string>): string {
  return keyFrom(name, taken, { fallback: "step", hyphen: true });
}

/** Every step id of a manifest, at any depth. */
export function stepIds(manifest: WorkflowManifest): Set<string> {
  const ids = new Set<string>();
  const steps = Array.isArray(manifest.steps) ? manifest.steps : [];
  for (const step of steps) if (isRecord(step)) for (const id of heldIds(step)) ids.add(id);
  return ids;
}

/** Whether a value of a step's fields names a step's result: `{ step, path }` at any depth. */
function reads(value: unknown, ids: ReadonlySet<string>): boolean {
  if (Array.isArray(value)) return value.some((item) => reads(item, ids));
  if (!isRecord(value)) return false;
  if (typeof value.step === "string" && typeof value.path === "string" && ids.has(value.step)) {
    return true;
  }
  return Object.values(value).some((item) => reads(item, ids));
}

/**
 * The steps that read the result of a step, or of a step it holds, and do not go with it: a
 * step whose result another reads cannot be deleted (workflow-canvas 9.6).
 */
export function readersOf(
  manifest: WorkflowManifest,
  id: string
): Readonly<Record<string, unknown>>[] {
  const step = findStep(manifest, id);
  if (step === undefined) return [];
  const going = new Set(heldIds(step));
  const found: Readonly<Record<string, unknown>>[] = [];
  const walk = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      if (!isRecord(entry)) continue;
      if (!going.has(String(entry.id))) {
        const own = Object.fromEntries(
          Object.entries(entry).filter(
            ([key]) => !["steps", "branches", "then", "else"].includes(key)
          )
        );
        if (reads(own, going)) found.push(entry);
      }
      for (const inner of innerLists(entry)) walk(inner);
    }
  };
  walk(manifest.steps);
  return found;
}
