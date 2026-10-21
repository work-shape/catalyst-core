import { sameValue, type WorkflowManifest } from "./step-edits";
import type { WorkflowStepView } from "./workflow-views";

// What a draft changes against the published revision, step by step (workflow-canvas 9.5):
// the canvas marks it, the Settings tab shows the published value under a changed field, and
// the draft bar lists it. Whoever made a change, the agent or a person, it is marked alike.

/** How a step of the draft differs from the published revision. */
export type DraftChange = "new" | "changed" | "removed";

/** A step of the published revision the draft no longer holds, with where it stood. */
export interface RemovedStep {
  id: string;
  /** The list it stood in: `""` at the top, else its block's id and the list's, as `loop/steps`. */
  list: string;
  /** The step before it in its list, where there was one. */
  after: string | undefined;
}

export interface DraftChanges {
  /** Every step that differs, by id: the draft's new and changed ones, and the removed ones. */
  steps: ReadonlyMap<string, DraftChange>;
  /** The fields of a changed step that differ, by step id. A moved step may have none. */
  fields: ReadonlyMap<string, readonly string[]>;
  removed: readonly RemovedStep[];
}

export const NO_DRAFT_CHANGES: DraftChanges = { steps: new Map(), fields: new Map(), removed: [] };

/** The keys of a step that hold other steps: they are compared as steps of their own. */
const INNER_KEYS: ReadonlySet<string> = new Set(["steps", "branches", "then", "else"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Placed {
  step: Record<string, unknown>;
  /** The list the step stands in: its block's id and which of its lists, or the top. */
  list: string;
  parentId: string | undefined;
  after: string | undefined;
}

/** Every step of a manifest by its id, with the list it stands in. */
function placed(manifest: WorkflowManifest): {
  steps: Map<string, Placed>;
  lists: Map<string, string[]>;
} {
  const steps = new Map<string, Placed>();
  const lists = new Map<string, string[]>();
  const walk = (list: unknown, key: string, parentId: string | undefined) => {
    if (!Array.isArray(list)) return;
    const ids: string[] = [];
    lists.set(key, ids);
    let after: string | undefined;
    for (const step of list) {
      if (!isRecord(step) || typeof step.id !== "string") continue;
      steps.set(step.id, { step, list: key, parentId, after });
      ids.push(step.id);
      after = step.id;
      walk(step.steps, `${step.id}/steps`, step.id);
      walk(step.then, `${step.id}/then`, step.id);
      walk(step.else, `${step.id}/else`, step.id);
      if (Array.isArray(step.branches)) {
        for (const branch of step.branches) {
          if (isRecord(branch) && typeof branch.id === "string") {
            walk(branch.steps, `${step.id}/${branch.id}`, step.id);
          }
        }
      }
    }
  };
  walk(manifest.steps, "", undefined);
  return { steps, lists };
}

/** The ids of `left` that keep their order in `right`: the longest common subsequence. */
function keptOrder(left: readonly string[], right: readonly string[]): Set<string> {
  const lengths = left.map(() => right.map(() => 0));
  const at = (i: number, j: number) => (i < 0 || j < 0 ? 0 : (lengths[i]?.[j] ?? 0));
  left.forEach((id, i) => {
    right.forEach((other, j) => {
      const row = lengths[i];
      if (row !== undefined) {
        row[j] = id === other ? at(i - 1, j - 1) + 1 : Math.max(at(i - 1, j), at(i, j - 1));
      }
    });
  });
  const kept = new Set<string>();
  let i = left.length - 1;
  let j = right.length - 1;
  while (i >= 0 && j >= 0) {
    if (left[i] === right[j]) {
      kept.add(left[i] ?? "");
      i -= 1;
      j -= 1;
    } else if (at(i - 1, j) >= at(i, j - 1)) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  return kept;
}

/** The fields of a step outside the steps it holds, and the names of a parallel step's paths. */
function changedFields(
  published: Record<string, unknown>,
  draft: Record<string, unknown>
): string[] {
  const keys = new Set([...Object.keys(published), ...Object.keys(draft)]);
  const fields = [...keys].filter(
    (key) => !INNER_KEYS.has(key) && !sameValue(published[key], draft[key])
  );
  const pathNames = (step: Record<string, unknown>) =>
    Array.isArray(step.branches)
      ? step.branches.map((branch) =>
          isRecord(branch) ? { id: branch.id, name: branch.name } : branch
        )
      : undefined;
  if (!sameValue(pathNames(published), pathNames(draft))) fields.push("branches");
  return fields;
}

/**
 * How the draft differs from the published revision, by step id. A step is new where the
 * published revision has no step of its id, removed where the draft has none, and changed
 * where a field of its own differs or it stands elsewhere: in another block, or out of order
 * among the steps both revisions hold in its list. A Workflow never published has no changes.
 */
export function draftChanges(
  published: WorkflowManifest | undefined,
  draft: WorkflowManifest
): DraftChanges {
  if (published === undefined) return NO_DRAFT_CHANGES;
  const before = placed(published);
  const now = placed(draft);
  const steps = new Map<string, DraftChange>();
  const fields = new Map<string, readonly string[]>();
  // Within one list, the steps both revisions hold there keep their order or were moved.
  const moved = new Set<string>();
  for (const [key, ids] of now.lists) {
    const common = ids.filter((id) => before.steps.get(id)?.list === key);
    const old = (before.lists.get(key) ?? []).filter((id) => now.steps.get(id)?.list === key);
    const kept = keptOrder(common, old);
    for (const id of common) if (!kept.has(id)) moved.add(id);
  }
  for (const [id, place] of now.steps) {
    const was = before.steps.get(id);
    if (was === undefined) {
      steps.set(id, "new");
      continue;
    }
    const changed = changedFields(was.step, place.step);
    if (changed.length > 0) fields.set(id, changed);
    if (changed.length > 0 || was.list !== place.list || moved.has(id)) steps.set(id, "changed");
  }
  const removed: RemovedStep[] = [];
  for (const [id, place] of before.steps) {
    if (now.steps.has(id)) continue;
    steps.set(id, "removed");
    // A step inside a removed block goes with it: only the block is drawn.
    if (place.parentId === undefined || now.steps.has(place.parentId)) {
      removed.push({ id, list: place.list, after: place.after });
    }
  }
  return { steps, fields, removed };
}

/**
 * The draft's steps with each removed step of the published revision put back where it stood:
 * after the step that came before it, or first in its list. The canvas draws them struck
 * through. `published` is the published revision's steps, of which the removed ones are taken.
 */
export function withRemovedSteps(
  draft: readonly WorkflowStepView[],
  published: readonly WorkflowStepView[],
  removed: readonly RemovedStep[]
): WorkflowStepView[] {
  if (removed.length === 0) return [...draft];
  const views = new Map<string, WorkflowStepView>();
  const collect = (list: readonly WorkflowStepView[]) => {
    for (const step of list) {
      views.set(step.id, step);
      collect(step.steps);
      for (const branch of step.branches ?? []) collect(branch.steps);
    }
  };
  collect(published);
  const into = (list: readonly WorkflowStepView[], key: string): WorkflowStepView[] => {
    const result = list.map((step): WorkflowStepView => ({
      ...step,
      steps: into(step.steps, `${step.id}/steps`),
      ...(step.branches === undefined
        ? {}
        : {
            branches: step.branches.map((branch) => ({
              ...branch,
              steps: into(branch.steps, `${step.id}/${branch.id}`)
            }))
          })
    }));
    for (const gone of removed) {
      const view = views.get(gone.id);
      if (view === undefined || gone.list !== key) continue;
      const at = gone.after === undefined ? -1 : result.findIndex((step) => step.id === gone.after);
      // A step whose neighbour is gone as well, or stands elsewhere now, ends its list.
      const index = gone.after === undefined ? 0 : at === -1 ? result.length : at + 1;
      result.splice(index, 0, view);
    }
    return result;
  };
  return into(draft, "");
}
