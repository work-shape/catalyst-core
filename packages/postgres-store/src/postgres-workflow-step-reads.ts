import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type {
  WorkflowBodyCounts,
  WorkflowLoopCounts,
  WorkflowRunsStore,
  WorkflowStepRunId,
  WorkflowStepRunView
} from "@work-shape/catalyst-core";
import { keysetFilter } from "./paging";
import type { PostgresConnection } from "./postgres-database";
import {
  mapPreview,
  loopInputPreview,
  storedInputPreview,
  mapStepRun,
  stepPreview,
  stepRunColumns
} from "./postgres-workflow-run-mapping";
import { workflowRuns, workflowStepRuns } from "./schema/workflowRuns";

type Input<Method extends keyof WorkflowRunsStore> = Parameters<WorkflowRunsStore[Method]>[0];

export async function listWorkflowStepRuns(
  db: PostgresConnection,
  input: Input<"listStepRuns">
): Promise<WorkflowStepRunView[]> {
  const { filter } = input;
  const rows = await db
    .select({
      ...stepRunColumns,
      preview: stepPreview,
      loopInputPreview,
      storedInputPreview,
      log: workflowStepRuns.log,
      childRunId: workflowRuns.id
    })
    .from(workflowStepRuns)
    .leftJoin(
      workflowRuns,
      and(
        eq(workflowRuns.clientInstanceId, workflowStepRuns.clientInstanceId),
        eq(workflowRuns.parentStepRunId, workflowStepRuns.id)
      )
    )
    .where(
      and(
        eq(workflowStepRuns.clientInstanceId, input.clientInstanceId),
        eq(workflowStepRuns.runId, input.runId),
        // An id no step run has matches none: it is a text like any other.
        // The steps of the definition's own list: a loop's step run, and none of its items.
        filter?.topLevel === true ? isNull(workflowStepRuns.containerStepRunId) : undefined,
        filter?.containerStepRunId === undefined
          ? undefined
          : sql`${workflowStepRuns.containerStepRunId} = ${filter.containerStepRunId}`,
        filter?.status === undefined ? undefined : eq(workflowStepRuns.status, filter.status),
        filter?.iteration === undefined
          ? undefined
          : eq(workflowStepRuns.iteration, filter.iteration),
        keysetFilter(input.page, [workflowStepRuns.createdAt, workflowStepRuns.id], false)
      )
    )
    .orderBy(asc(workflowStepRuns.createdAt), asc(workflowStepRuns.id))
    .limit(input.page?.limit ?? 2147483647);
  const loops = rows.filter((row) => row.stepType === "loop").map((row) => row.id);
  const counts = await countWorkflowLoops(db, loops);
  const bodies = await countWorkflowLoopBodies(db, loops, counts);
  return rows.map((row) => {
    const loop = counts.get(row.id);
    const bodyCounts = bodies.get(row.id);
    return {
      ...mapStepRun(row),
      ...mapPreview(row.preview),
      ...(row.storedInputPreview !== null
        ? { inputPreview: row.storedInputPreview }
        : row.loopInputPreview !== null
          ? { inputPreview: mapPreview(row.loopInputPreview).outputPreview }
          : {}),
      ...(row.childRunId === null ? {} : { childRunId: row.childRunId }),
      ...(row.log === null ? {} : { log: row.log }),
      ...(loop ? { loop } : {}),
      ...(bodyCounts ? { bodyCounts } : {})
    };
  });
}

/**
 * How the step runs of each step directly inside each of the named loop step runs stand, by
 * step id. `total` is the number of the loop's items: each step runs once for an item. A step
 * no item has reached yet has no entry here; whoever knows the definition adds it.
 */
async function countWorkflowLoopBodies(
  db: PostgresConnection,
  loopStepRunIds: WorkflowStepRunId[],
  loops: Map<string, WorkflowLoopCounts>
): Promise<Map<string, WorkflowBodyCounts>> {
  const bodies = new Map<string, WorkflowBodyCounts>();
  if (loopStepRunIds.length === 0) return bodies;
  for (const id of loopStepRunIds) bodies.set(id, {});
  const rows = await db
    .select({
      loop: workflowStepRuns.containerStepRunId,
      stepId: workflowStepRuns.stepId,
      done: sql<number>`(count(*) filter (where ${workflowStepRuns.status} = 'done'))::int`,
      failed: sql<number>`(count(*) filter (where ${workflowStepRuns.status} = 'failed'))::int`,
      running: sql<number>`(count(*) filter (where ${workflowStepRuns.status} in ('queued', 'running', 'waiting')))::int`
    })
    .from(workflowStepRuns)
    .where(inArray(workflowStepRuns.containerStepRunId, loopStepRunIds))
    .groupBy(workflowStepRuns.containerStepRunId, workflowStepRuns.stepId);
  for (const row of rows) {
    const body = row.loop === null ? undefined : bodies.get(row.loop);
    if (!body || row.loop === null) continue;
    body[row.stepId] = {
      total: loops.get(row.loop)?.total ?? 0,
      done: row.done,
      failed: row.failed,
      running: row.running
    };
  }
  return bodies;
}

/**
 * How far each of the named loop step runs is. An item is failed when one of its step runs
 * is, running while one of them has not ended, and done when the step run of the loop's last
 * step is. An item no step run exists for yet, and one that a cancel or a limit cut off
 * between two of its steps, is in `total` alone.
 */
export async function countWorkflowLoops(
  db: PostgresConnection,
  loopStepRunIds: WorkflowStepRunId[]
): Promise<Map<string, WorkflowLoopCounts>> {
  const counts = new Map<string, WorkflowLoopCounts>();
  if (loopStepRunIds.length === 0) return counts;
  const totals = await db
    .select({
      id: workflowStepRuns.id,
      last: sql<string | null>`${workflowStepRuns.input}->>'last'`,
      // A loop whose list was removed with its run's values kept the length of the list.
      total: sql<number>`coalesce((${workflowStepRuns.input}->>'total')::int, jsonb_array_length(${workflowStepRuns.input}->'items'), 0)::int`
    })
    .from(workflowStepRuns)
    .where(inArray(workflowStepRuns.id, loopStepRunIds));
  const last = new Map(totals.map((loop) => [loop.id, loop.last]));
  for (const { id, total } of totals) counts.set(id, { total, done: 0, failed: 0, running: 0 });
  const items = await db
    .select({
      loop: workflowStepRuns.containerStepRunId,
      failed: sql<boolean>`bool_or(${workflowStepRuns.status} = 'failed')`,
      open: sql<boolean>`bool_or(${workflowStepRuns.status} in ('queued', 'running', 'waiting'))`,
      // The step ids of the item's step runs that ended as done.
      done: sql<
        string[]
      >`coalesce(array_agg(${workflowStepRuns.stepId}) filter (where ${workflowStepRuns.status} = 'done'), '{}')`
    })
    .from(workflowStepRuns)
    .where(inArray(workflowStepRuns.containerStepRunId, loopStepRunIds))
    .groupBy(workflowStepRuns.containerStepRunId, workflowStepRuns.iteration);
  for (const item of items) {
    const count = item.loop === null ? undefined : counts.get(item.loop);
    if (!count) continue;
    if (item.failed) count.failed += 1;
    else if (item.open) count.running += 1;
    else if (item.done.includes((item.loop === null ? null : last.get(item.loop)) ?? "")) {
      count.done += 1;
    }
  }
  return counts;
}
