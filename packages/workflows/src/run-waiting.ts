import type { ClientInstanceId, PlatformStores, WorkflowRun } from "@work-shape/catalyst-core";
import { workflowDeadlineJobKind, workflowDeadlineKey } from "./run-deadline";

// Time a run spends waiting counts toward no limit (EW-LIM). A run waits while every open step
// of it waits for something outside it: an asynchronous operation, a run linked by key, or
// a child that waits as well. A parent whose child works is working, so the parent waits only while the child does.
// From the moment it waits the run carries `waitingSince`; when a step of it is taken up again
// its deadline moves later by the time it waited, so the deadline stays one comparison.
//
// What waits changes in a run and in the runs above it at once, so the engine locks them top
// down before the run: the lock order of the whole engine, in which an end locks a parent and
// then its children.

/** A run, locked, with the runs above it, locked before it: the nearest first. */
export interface LockedRunChain {
  run: WorkflowRun;
  ancestors: WorkflowRun[];
}

export function createRunWaiting(options: { clientInstanceId: ClientInstanceId; now(): Date }) {
  const { clientInstanceId, now } = options;

  /** Locks a run behind its root and its parent. Nothing where the run does not exist. */
  async function lockChain(tx: PlatformStores, runId: string): Promise<LockedRunChain | undefined> {
    // The lineage of a run never changes, so it is read before the locks.
    const known = await tx.workflowRuns.readRun({ clientInstanceId, id: runId });
    if (!known) return undefined;
    const above = [
      ...new Set(
        [known.rootRunId, known.parentRunId, known.continuation?.rootRunId].filter(
          (id): id is NonNullable<typeof id> => id !== undefined && id !== known.id
        )
      )
    ];
    const ancestors: WorkflowRun[] = [];
    for (const id of above) {
      const locked = await tx.workflowRuns.lockRun({ clientInstanceId, id });
      // The Lauf root serializes cancellation and successor claims; it is historical,
      // not a waiting parent whose deadline should move with this run.
      if (locked && (id === known.rootRunId || id === known.parentRunId)) ancestors.unshift(locked);
    }
    const run = await tx.workflowRuns.lockRun({ clientInstanceId, id: known.id });
    return run ? { run, ancestors } : undefined;
  }

  /**
   * After a step of the run settled: the run waits from now where every open step of it does,
   * and so, one after the other, does each run above it whose open steps all wait.
   */
  async function noteWaiting(tx: PlatformStores, chain: LockedRunChain): Promise<void> {
    const at = now().toISOString();
    for (const run of [chain.run, ...chain.ancestors]) {
      if (!(await tx.workflowRuns.markRunWaiting({ clientInstanceId, id: run.id, at }))) return;
    }
  }

  /**
   * A step of the run is taken up: the wait of the run ends, and that of every run above it,
   * which waited only because this one did. Each deadline moves by the run's own wait, and its
   * job is queued for it. Answers the run as it now stands.
   */
  async function endWaits(tx: PlatformStores, chain: LockedRunChain): Promise<WorkflowRun> {
    if (chain.run.waitingSince === undefined) return chain.run;
    const at = now().toISOString();
    let current = chain.run;
    for (const run of [chain.run, ...chain.ancestors]) {
      if (run.waitingSince === undefined) break;
      const moved = await tx.workflowRuns.endRunWait({ clientInstanceId, id: run.id, at });
      if (!moved) break;
      if (moved.id === chain.run.id) current = moved;
      // A deadline job that is still queued finds the deadline moved and waits for it; one
      // that ended while the run waited is queued again here.
      await tx.jobs.enqueue(
        workflowDeadlineJobKind,
        { runId: moved.id },
        {
          clientInstanceId,
          subject: moved.id,
          dedupeKey: workflowDeadlineKey(moved.id),
          runAfter: new Date(moved.deadlineAt),
          correlationId: moved.correlationId
        }
      );
    }
    return current;
  }

  return { lockChain, noteWaiting, endWaits };
}
