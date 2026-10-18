import { and, eq, notInArray } from "drizzle-orm";
import {
  WORKFLOW_KEY_RELEASING_STATUSES,
  type WorkflowRun,
  type WorkflowRunsStore
} from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { workflowRuns } from "./schema/workflowRuns";
import { runColumns, runIs, mapRun } from "./postgres-workflow-run-mapping";

type Input<Method extends keyof WorkflowRunsStore> = Parameters<WorkflowRunsStore[Method]>[0];

/**
 * The one run-row lock order: root, parent, child. A continuation's first part precedes
 * its later parts too. Lineage is immutable and may be read before taking locks. Every
 * run lock, including keyed holders and dataset writers, comes through this module.
 * Transactions must hold these locks before changing run or step state.
 */
export async function lockWorkflowRun(
  db: PostgresConnection,
  ref: Input<"lockRun">
): Promise<WorkflowRun | undefined> {
  const visited = new Set<string>();
  async function lock(id: string): Promise<WorkflowRun | undefined> {
    if (visited.has(id)) return undefined;
    visited.add(id);
    const [known] = await db
      .select({
        root: workflowRuns.rootRunId,
        parent: workflowRuns.parentRunId,
        continuation: workflowRuns.continuation
      })
      .from(workflowRuns)
      .where(runIs({ ...ref, id }));
    if (!known) return undefined;
    for (const above of [known.root, known.parent, known.continuation?.rootRunId]) {
      if (above && above !== id) await lock(above);
    }
    const [row] = await db
      .select(runColumns)
      .from(workflowRuns)
      .where(runIs({ ...ref, id }))
      .for("update");
    return row ? mapRun(row) : undefined;
  }
  return lock(ref.id);
}

export async function lockWorkflowRunByKey(
  db: PostgresConnection,
  input: Input<"lockRunByKey">
): Promise<WorkflowRun | undefined> {
  // The predicate of `workflow_runs_active_run_key_idx`: the run that holds the key, read again
  // behind its lock, so one that ended `failed` while this waited is no longer it.
  const [row] = await db
    .select(runColumns)
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.clientInstanceId, input.clientInstanceId),
        eq(workflowRuns.workflow, input.workflow),
        eq(workflowRuns.mode, input.mode),
        eq(workflowRuns.runKey, input.runKey),
        notInArray(workflowRuns.status, [...WORKFLOW_KEY_RELEASING_STATUSES])
      )
    )
    .limit(1);
  if (!row) return undefined;
  const locked = await lockWorkflowRun(db, {
    clientInstanceId: input.clientInstanceId,
    id: row.id
  });
  // Recheck behind the lock: a holder can release its key while this transaction waits.
  return locked && !WORKFLOW_KEY_RELEASING_STATUSES.some((status) => status === locked.status)
    ? locked
    : undefined;
}
