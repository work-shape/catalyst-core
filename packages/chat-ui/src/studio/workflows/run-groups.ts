import { doneWithFailedRuns } from "./workflow-model";
import type { WorkflowRunView } from "./workflow-views";

// A run that continued as new (EW-CAN) is one Lauf of several parts. The list shows the parts
// it holds as one row, wherever the parts stand in the list and however many of them loaded.

/** One part of a Lauf with what the list says beside it. */
export interface RunPart {
  run: WorkflowRunView;
  /** The part's number, from 1 for the run that was started. */
  number: number;
  /**
   * The part runs on another published revision than the part before it. Unknown, and false,
   * while the part before it has not loaded.
   */
  revisionChanged: boolean;
}

/** The parts of one Lauf that the list holds, newest first. */
export interface RunGroup {
  /** The id of the Lauf's first part, also while that part has not loaded. */
  rootRunId: string;
  parts: readonly RunPart[];
  /** The part with the highest number: its state is the Lauf's. */
  latest: WorkflowRunView;
  /** The part with the lowest number the list holds. */
  earliest: WorkflowRunView;
  /** Part 1 has not loaded: older pages of the list hold the parts before `earliest`. */
  partial: boolean;
  /** The step runs of the loaded parts together, where each part counts its own. */
  stepRuns?: number;
  /** Some loaded part runs on another revision than the part before it. */
  revisionChanged: boolean;
}

/** One row of the list: a run, a Lauf, or runs side by side that found nothing to do. */
type RunsListEntry =
  | { kind: "run"; run: WorkflowRunView }
  | { kind: "group"; group: RunGroup }
  | { kind: "empty"; runs: readonly WorkflowRunView[] };

/** The fewest empty runs side by side that fold into one row. A lone one stands as it is. */
const FOLD_FROM = 2;

function groupOf(rootRunId: string, runs: readonly WorkflowRunView[]): RunGroup {
  const byId = new Map(runs.map((run) => [run.id, run]));
  const ordered = [...runs].sort(
    (a, b) => (b.continuation?.number ?? 0) - (a.continuation?.number ?? 0)
  );
  const parts = ordered.map((run): RunPart => {
    const previousId = run.continuation?.previousRunId;
    const previous = previousId === undefined ? undefined : byId.get(previousId);
    return {
      run,
      number: run.continuation?.number ?? 1,
      revisionChanged:
        previous?.revisionId !== undefined &&
        run.revisionId !== undefined &&
        previous.revisionId !== run.revisionId
    };
  });
  const latest = ordered[0];
  const earliest = ordered[ordered.length - 1];
  if (latest === undefined || earliest === undefined) {
    throw new Error("A Lauf holds at least one part.");
  }
  const counted = runs.every((run) => run.stepRuns !== undefined);
  return {
    rootRunId,
    parts,
    latest,
    earliest,
    partial: (earliest.continuation?.number ?? 1) > 1,
    ...(counted ? { stepRuns: runs.reduce((sum, run) => sum + (run.stepRuns ?? 0), 0) } : {}),
    revisionChanged: parts.some((part) => part.revisionChanged)
  };
}

/**
 * The rows of the list in their order. The parts of a Lauf form one row where its newest loaded
 * part stands, also when other runs stand between them. A stretch of empty runs folds into one
 * row; a test run, a failed run and a part of a Lauf always stand.
 */
export function runsListEntries(runs: readonly WorkflowRunView[]): RunsListEntry[] {
  const groups = new Map<string, WorkflowRunView[]>();
  for (const run of runs) {
    const root = run.continuation?.rootRunId;
    if (root !== undefined) {
      groups.set(root, [...(groups.get(root) ?? []), run]);
    }
  }
  const entries: RunsListEntry[] = [];
  const placed = new Set<string>();
  let stretch: WorkflowRunView[] = [];
  const close = () => {
    if (stretch.length >= FOLD_FROM) {
      entries.push({ kind: "empty", runs: stretch });
    } else {
      entries.push(...stretch.map((run) => ({ kind: "run" as const, run })));
    }
    stretch = [];
  };
  for (const run of runs) {
    const root = run.continuation?.rootRunId;
    if (root !== undefined) {
      if (placed.has(root)) continue;
      placed.add(root);
      close();
      entries.push({ kind: "group", group: groupOf(root, groups.get(root) ?? [run]) });
    } else if (run.empty && run.status === "done" && !run.test && !doneWithFailedRuns(run)) {
      stretch.push(run);
    } else {
      close();
      entries.push({ kind: "run", run });
    }
  }
  close();
  return entries;
}
