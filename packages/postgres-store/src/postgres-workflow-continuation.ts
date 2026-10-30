import { and, eq, isNull, sql } from "drizzle-orm";
import type { WorkflowRun, WorkflowRunsStore } from "@work-shape/catalyst-core";
import type { PostgresConnection } from "./postgres-database";
import { workflowRuns, workflowStepRuns } from "./schema/workflowRuns";
import { mapRun, notEnded, runColumns, runIs } from "./postgres-workflow-run-mapping";
type Input<Method extends keyof WorkflowRunsStore> = Parameters<WorkflowRunsStore[Method]>[0];
export async function createWorkflowRun(
  db: PostgresConnection,
  run: Input<"createRun">
): Promise<WorkflowRun | undefined> {
  const [row] = await db
    .insert(workflowRuns)
    .values({
      id: run.id,
      clientInstanceId: run.clientInstanceId,
      workflow: run.workflow,
      definitionRevisionId: run.definitionRevisionId,
      mode: run.mode,
      trigger: run.trigger,
      status: "queued",
      definition: run.definition,
      input: run.input,
      checkpoint: run.checkpoint ?? null,
      principalId: run.principal.id,
      principalName: run.principal.name,
      principalLabel: run.principal.displayLabel,
      startedBy: run.startedBy,
      rootRunId: run.rootRunId ?? run.id,
      depth: run.depth ?? 0,
      parentRunId: run.parentRunId ?? null,
      parentStepRunId: run.parentStepRunId ?? null,
      itemIndex: run.itemIndex ?? null,
      itemLabel: run.itemLabel ?? null,
      operationRunId: run.operationRunId ?? null,
      starterRunId: run.starterRunId ?? null,
      startedFrom: run.startedFrom ?? null,
      pinnedSteps: run.pinnedSteps ?? null,
      deadlineAt: new Date(run.deadlineAt),
      limits: run.limits,
      correlationId: run.correlationId,
      createdAt: new Date(run.createdAt),
      scheduledFor: run.scheduledFor === undefined ? null : new Date(run.scheduledFor),
      runKey: run.runKey ?? null,
      labels: run.labels ?? null,
      continuation: run.continuation ?? null
    })
    // The conflicts a new id can meet: the due time of a schedule that has its run, the run
    // key of an open or done run, and the Operation Run of a start that wrote its run. An
    // insert that meets a key another start has written and not committed waits for it.
    .onConflictDoNothing()
    .returning(runColumns);
  return row ? mapRun(row) : undefined;
}

export function continuationWorkflowRuns(
  db: PostgresConnection
): Pick<
  WorkflowRunsStore,
  | "readCheckpoint"
  | "requestContinuation"
  | "markContinuation"
  | "handoffContinuation"
  | "readLoopProgress"
> {
  return {
    async readCheckpoint(ref) {
      const [row] = await db
        .select({ checkpoint: workflowRuns.checkpoint })
        .from(workflowRuns)
        .where(runIs(ref));
      return row?.checkpoint ?? undefined;
    },
    async requestContinuation(ref) {
      await db
        .update(workflowRuns)
        .set({
          checkpoint: sql`coalesce(${workflowRuns.checkpoint}, '{"stepId":"","offset":0}'::jsonb) || ${JSON.stringify({ pending: ref.pending })}::jsonb`
        })
        .where(runIs(ref));
    },
    async handoffContinuation(ref) {
      await db
        .update(workflowRuns)
        .set({
          continuation: sql`jsonb_set(${workflowRuns.continuation}, '{successorRunId}', to_jsonb(${ref.successorId}::text))`
        })
        .where(runIs(ref));
      await db
        .update(workflowStepRuns)
        .set({ linkedRunId: ref.successorId })
        .where(
          and(
            eq(workflowStepRuns.clientInstanceId, ref.clientInstanceId),
            eq(workflowStepRuns.linkedRunId, ref.id),
            notEnded(workflowStepRuns.status)
          )
        );
    },
    async markContinuation(ref) {
      await db
        .update(workflowRuns)
        .set({
          continuation: sql`jsonb_build_object('rootRunId', ${workflowRuns.id}, 'number', 1)`
        })
        .where(and(runIs(ref), isNull(workflowRuns.continuation)));
    },

    async readLoopProgress(ref) {
      const [row] = await db
        .select({ input: workflowStepRuns.input })
        .from(workflowStepRuns)
        .where(
          and(
            eq(workflowStepRuns.clientInstanceId, ref.clientInstanceId),
            sql`${workflowStepRuns.id} = ${ref.id}`
          )
        );
      if (row?.input?.started !== undefined && row.input.ended !== undefined)
        return { started: row.input.started, running: row.input.started - row.input.ended };
      // Runs opened by older releases have no rollup. They finish using their existing path.
      const [counts] = await db
        .select({
          started: sql<number>`coalesce(max(iteration) + 1, 0)::int`,
          running: sql<number>`count(distinct iteration) filter (where status in ('queued', 'running', 'waiting'))::int`
        })
        .from(workflowStepRuns)
        .where(
          and(
            eq(workflowStepRuns.clientInstanceId, ref.clientInstanceId),
            sql`${workflowStepRuns.containerStepRunId} = ${ref.id}`
          )
        );
      return counts ?? { started: 0, running: 0 };
    }
  };
}

/** Updated in the same transaction as the step transition, behind the run lock. */
export async function noteLoopStarted(
  db: PostgresConnection,
  row: Pick<
    typeof workflowStepRuns.$inferSelect,
    "clientInstanceId" | "containerStepRunId" | "stepId"
  >
) {
  if (!row.containerStepRunId) return;
  await db
    .update(workflowStepRuns)
    .set({
      input: sql`jsonb_set(${workflowStepRuns.input}, '{started}', to_jsonb(coalesce((${workflowStepRuns.input}->>'started')::int, 0) + 1))`
    })
    .where(
      and(
        eq(workflowStepRuns.clientInstanceId, row.clientInstanceId),
        eq(workflowStepRuns.id, row.containerStepRunId),
        sql`${workflowStepRuns.input}->>'first' = ${row.stepId}`
      )
    );
}

export async function noteLoopEnded(
  db: PostgresConnection,
  row: Pick<
    typeof workflowStepRuns.$inferSelect,
    "clientInstanceId" | "containerStepRunId" | "stepId" | "status"
  >
) {
  if (!row.containerStepRunId || (row.status !== "done" && row.status !== "failed")) return;
  await db
    .update(workflowStepRuns)
    .set({
      input: sql`jsonb_set(${workflowStepRuns.input}, '{ended}', to_jsonb(coalesce((${workflowStepRuns.input}->>'ended')::int, 0) + 1))`
    })
    .where(
      and(
        eq(workflowStepRuns.clientInstanceId, row.clientInstanceId),
        eq(workflowStepRuns.id, row.containerStepRunId),
        sql`${workflowStepRuns.input} ? 'first'`,
        row.status === "failed"
          ? sql`true`
          : sql`${workflowStepRuns.input}->>'last' = ${row.stepId}`
      )
    );
}
