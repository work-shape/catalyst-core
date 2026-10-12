import { and, asc, desc, eq, getTableColumns, inArray, isNull, notInArray, sql } from "drizzle-orm";
import {
  WORKFLOW_ENDED_STATUSES,
  WORKFLOW_OUTPUT_PREVIEW_MAX_CHARS,
  type JsonObject,
  type JsonValue,
  type WorkflowLoopCounts,
  type WorkflowOutputPreview,
  type WorkflowRun,
  type WorkflowRunsStore,
  type WorkflowRunView,
  type WorkflowStepRun,
  type WorkflowStepRunId,
  type WorkflowStepRunView
} from "@vivd-catalyst/core";
import { keysetFilter } from "./paging";
import type { PostgresConnection } from "./postgres-database";
import { workflowRuns, workflowStepRuns } from "./schema/workflowRuns";

type Input<Method extends keyof WorkflowRunsStore> = Parameters<WorkflowRunsStore[Method]>[0];

type RunRow = typeof workflowRuns.$inferSelect;
type StepRunRow = typeof workflowStepRuns.$inferSelect;

// A run and a step run without the values they carry: the engine reads those one at a time.
const { input: _runInput, output: _runOutput, ...runColumns } = getTableColumns(workflowRuns);
const {
  input: _stepInput,
  output: _stepOutput,
  ...stepRunColumns
} = getTableColumns(workflowStepRuns);

// One character more than a preview shows, so a cut value is told from one that just fits.
const previewOf = (column: typeof workflowRuns.output | typeof workflowStepRuns.output) =>
  sql<
    string | null
  >`left((${column}->'value')::text, ${sql.raw(String(WORKFLOW_OUTPUT_PREVIEW_MAX_CHARS + 1))})`;

function mapPreview(text: string | null): { outputPreview?: WorkflowOutputPreview } {
  if (text === null) return {};
  const truncated = text.length > WORKFLOW_OUTPUT_PREVIEW_MAX_CHARS;
  return {
    outputPreview: {
      text: truncated ? text.slice(0, WORKFLOW_OUTPUT_PREVIEW_MAX_CHARS) : text,
      truncated
    }
  };
}

function mapRunView(row: Omit<RunRow, "input" | "output" | "definition">): WorkflowRunView {
  return {
    id: row.id,
    clientInstanceId: row.clientInstanceId,
    workflow: row.workflow,
    revision: row.revision,
    mode: row.mode,
    trigger: row.trigger,
    status: row.status,
    principal: { id: row.principalId, displayLabel: row.principalLabel },
    startedBy: row.startedBy,
    ...(row.operationRunId === null ? {} : { operationRunId: row.operationRunId }),
    stepRunCount: row.stepRunCount,
    deadlineAt: row.deadlineAt.toISOString(),
    ...(row.error === null ? {} : { error: row.error }),
    correlationId: row.correlationId,
    createdAt: row.createdAt.toISOString(),
    ...(row.startedAt === null ? {} : { startedAt: row.startedAt.toISOString() }),
    ...(row.finishedAt === null ? {} : { finishedAt: row.finishedAt.toISOString() })
  };
}

function mapRun(row: Omit<RunRow, "input" | "output">): WorkflowRun {
  return { ...mapRunView(row), definition: row.definition };
}

function mapStepRun(row: Omit<StepRunRow, "input" | "output">): WorkflowStepRun {
  return {
    id: row.id,
    clientInstanceId: row.clientInstanceId,
    runId: row.runId,
    stepId: row.stepId,
    stepType: row.stepType,
    key: row.key,
    ...(row.parentStepRunId === null ? {} : { parentStepRunId: row.parentStepRunId }),
    ...(row.iteration === null ? {} : { iteration: row.iteration }),
    ...(row.iterationLabel === null ? {} : { iterationLabel: row.iterationLabel }),
    status: row.status,
    attempt: row.attempt,
    ...(row.operationRunId === null ? {} : { operationRunId: row.operationRunId }),
    ...(row.error === null ? {} : { error: row.error }),
    createdAt: row.createdAt.toISOString(),
    ...(row.startedAt === null ? {} : { startedAt: row.startedAt.toISOString() }),
    ...(row.finishedAt === null ? {} : { finishedAt: row.finishedAt.toISOString() })
  };
}

const runIs = (ref: { clientInstanceId: RunRow["clientInstanceId"]; id: string }) =>
  and(eq(workflowRuns.clientInstanceId, ref.clientInstanceId), sql`${workflowRuns.id} = ${ref.id}`);

const stepRunIs = (ref: Input<"getStepRun">) =>
  and(
    eq(workflowStepRuns.clientInstanceId, ref.clientInstanceId),
    sql`${workflowStepRuns.id} = ${ref.id}`
  );

const notEnded = (column: typeof workflowRuns.status | typeof workflowStepRuns.status) =>
  notInArray(column, [...WORKFLOW_ENDED_STATUSES]);

export async function createWorkflowRun(
  db: PostgresConnection,
  run: Input<"createRun">
): Promise<WorkflowRun> {
  const [row] = await db
    .insert(workflowRuns)
    .values({
      id: run.id,
      clientInstanceId: run.clientInstanceId,
      workflow: run.workflow,
      revision: run.revision,
      mode: run.mode,
      trigger: run.trigger,
      status: "queued",
      definition: run.definition,
      input: run.input,
      principalId: run.principal.id,
      principalLabel: run.principal.displayLabel,
      startedBy: run.startedBy,
      operationRunId: run.operationRunId ?? null,
      deadlineAt: new Date(run.deadlineAt),
      correlationId: run.correlationId,
      createdAt: new Date(run.createdAt)
    })
    .returning(runColumns);
  if (!row) throw new Error("Workflow run insert returned no row");
  return mapRun(row);
}

export async function lockWorkflowRun(
  db: PostgresConnection,
  ref: Input<"lockRun">
): Promise<WorkflowRun | undefined> {
  const [row] = await db.select(runColumns).from(workflowRuns).where(runIs(ref)).for("update");
  return row ? mapRun(row) : undefined;
}

export async function readWorkflowRun(
  db: PostgresConnection,
  input: Input<"readRun">
): Promise<WorkflowRunView | undefined> {
  const [row] = await db
    .select({ ...runColumns, preview: previewOf(workflowRuns.output) })
    .from(workflowRuns)
    .where(runIs(input));
  return row ? { ...mapRunView(row), ...mapPreview(row.preview) } : undefined;
}

export async function listWorkflowRuns(
  db: PostgresConnection,
  input: Input<"listRuns">
): Promise<WorkflowRunView[]> {
  const rows = await db
    .select({ ...runColumns, preview: previewOf(workflowRuns.output) })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.clientInstanceId, input.clientInstanceId),
        eq(workflowRuns.workflow, input.workflow),
        keysetFilter(input.page, [workflowRuns.createdAt, workflowRuns.id], true)
      )
    )
    .orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.id))
    .limit(input.page?.limit ?? 2147483647);
  return rows.map((row) => ({ ...mapRunView(row), ...mapPreview(row.preview) }));
}

export async function readWorkflowRunInput(
  db: PostgresConnection,
  ref: Input<"readRunInput">
): Promise<JsonObject | undefined> {
  const [row] = await db.select({ input: workflowRuns.input }).from(workflowRuns).where(runIs(ref));
  return row?.input;
}

export async function markWorkflowRunRunning(
  db: PostgresConnection,
  ref: Input<"markRunRunning">
): Promise<void> {
  await db
    .update(workflowRuns)
    .set({ status: "running", startedAt: new Date(ref.startedAt) })
    .where(and(runIs(ref), eq(workflowRuns.status, "queued")));
}

export async function endWorkflowRun(
  db: PostgresConnection,
  ref: Input<"endRun">
): Promise<boolean> {
  const ended = await db
    .update(workflowRuns)
    .set({
      status: ref.status,
      finishedAt: new Date(ref.finishedAt),
      output: ref.output === undefined ? null : { value: ref.output },
      error: ref.error ?? null
    })
    .where(and(runIs(ref), notEnded(workflowRuns.status)))
    .returning({ id: workflowRuns.id });
  return ended.length > 0;
}

export async function createWorkflowStepRun(
  db: PostgresConnection,
  stepRun: Input<"createStepRun">
): Promise<WorkflowStepRun> {
  const [row] = await db
    .insert(workflowStepRuns)
    .values({
      id: stepRun.id,
      clientInstanceId: stepRun.clientInstanceId,
      runId: stepRun.runId,
      stepId: stepRun.stepId,
      stepType: stepRun.stepType,
      key: stepRun.key,
      parentStepRunId: stepRun.parentStepRunId ?? null,
      iteration: stepRun.iteration ?? null,
      iterationLabel: stepRun.iterationLabel ?? null,
      status: "queued",
      createdAt: new Date(stepRun.createdAt)
    })
    .returning(stepRunColumns);
  if (!row) throw new Error("Workflow step run insert returned no row");
  await db
    .update(workflowRuns)
    .set({ stepRunCount: sql`${workflowRuns.stepRunCount} + 1` })
    .where(runIs({ clientInstanceId: stepRun.clientInstanceId, id: stepRun.runId }));
  return mapStepRun(row);
}

export async function getWorkflowStepRun(
  db: PostgresConnection,
  ref: Input<"getStepRun">
): Promise<WorkflowStepRun | undefined> {
  const [row] = await db.select(stepRunColumns).from(workflowStepRuns).where(stepRunIs(ref));
  return row ? mapStepRun(row) : undefined;
}

export async function markWorkflowStepRunRunning(
  db: PostgresConnection,
  ref: Input<"markStepRunRunning">
): Promise<void> {
  await db
    .update(workflowStepRuns)
    .set({
      status: "running",
      attempt: ref.attempt,
      startedAt: sql`coalesce(${workflowStepRuns.startedAt}, ${ref.startedAt}::timestamptz)`
    })
    .where(and(stepRunIs(ref), notEnded(workflowStepRuns.status)));
}

export async function endWorkflowStepRun(
  db: PostgresConnection,
  ref: Input<"endStepRun">
): Promise<boolean> {
  const ended = await db
    .update(workflowStepRuns)
    .set({
      status: ref.status,
      finishedAt: new Date(ref.finishedAt),
      output: ref.output === undefined ? null : { value: ref.output },
      ...(ref.operationRunId === undefined ? {} : { operationRunId: ref.operationRunId }),
      error: ref.error ?? null
    })
    .where(and(stepRunIs(ref), notEnded(workflowStepRuns.status)))
    .returning({ id: workflowStepRuns.id });
  return ended.length > 0;
}

export async function markWorkflowLoopWaiting(
  db: PostgresConnection,
  ref: Input<"markLoopWaiting">
): Promise<void> {
  await db
    .update(workflowStepRuns)
    .set({ status: "waiting", input: { items: [...ref.items] } })
    .where(and(stepRunIs(ref), eq(workflowStepRuns.status, "running")));
}

export async function listOpenWorkflowStepRuns(
  db: PostgresConnection,
  ref: Input<"listOpenStepRuns">
): Promise<WorkflowStepRun[]> {
  const rows = await db
    .select(stepRunColumns)
    .from(workflowStepRuns)
    .where(
      and(
        eq(workflowStepRuns.clientInstanceId, ref.clientInstanceId),
        eq(workflowStepRuns.runId, ref.id),
        notEnded(workflowStepRuns.status)
      )
    )
    .orderBy(asc(workflowStepRuns.createdAt), asc(workflowStepRuns.id));
  return rows.map(mapStepRun);
}

export async function listWorkflowStepRuns(
  db: PostgresConnection,
  input: Input<"listStepRuns">
): Promise<WorkflowStepRunView[]> {
  const rows = await db
    .select({ ...stepRunColumns, preview: previewOf(workflowStepRuns.output) })
    .from(workflowStepRuns)
    .where(
      and(
        eq(workflowStepRuns.clientInstanceId, input.clientInstanceId),
        eq(workflowStepRuns.runId, input.runId),
        keysetFilter(input.page, [workflowStepRuns.createdAt, workflowStepRuns.id], false)
      )
    )
    .orderBy(asc(workflowStepRuns.createdAt), asc(workflowStepRuns.id))
    .limit(input.page?.limit ?? 2147483647);
  const counts = await countWorkflowLoops(
    db,
    rows.filter((row) => row.stepType === "loop").map((row) => row.id)
  );
  return rows.map((row) => {
    const loop = counts.get(row.id);
    return { ...mapStepRun(row), ...mapPreview(row.preview), ...(loop ? { loop } : {}) };
  });
}

/**
 * How far each of the named loop step runs is. An item is failed when one of its step runs
 * is, running while one of them has not ended, and done when all of them ended as done. An
 * item no step run exists for yet, or one a cancel ended, is in `total` alone.
 */
async function countWorkflowLoops(
  db: PostgresConnection,
  loopStepRunIds: WorkflowStepRunId[]
): Promise<Map<string, WorkflowLoopCounts>> {
  const counts = new Map<string, WorkflowLoopCounts>();
  if (loopStepRunIds.length === 0) return counts;
  const totals = await db
    .select({
      id: workflowStepRuns.id,
      total: sql<number>`coalesce(jsonb_array_length(${workflowStepRuns.input}->'items'), 0)::int`
    })
    .from(workflowStepRuns)
    .where(inArray(workflowStepRuns.id, loopStepRunIds));
  for (const { id, total } of totals) counts.set(id, { total, done: 0, failed: 0, running: 0 });
  const items = await db
    .select({
      loop: workflowStepRuns.parentStepRunId,
      failed: sql<boolean>`bool_or(${workflowStepRuns.status} = 'failed')`,
      open: sql<boolean>`bool_or(${workflowStepRuns.status} in ('queued', 'running', 'waiting'))`,
      done: sql<boolean>`bool_and(${workflowStepRuns.status} = 'done')`
    })
    .from(workflowStepRuns)
    .where(inArray(workflowStepRuns.parentStepRunId, loopStepRunIds))
    .groupBy(workflowStepRuns.parentStepRunId, workflowStepRuns.iteration);
  for (const item of items) {
    const count = item.loop === null ? undefined : counts.get(item.loop);
    if (!count) continue;
    if (item.failed) count.failed += 1;
    else if (item.open) count.running += 1;
    else if (item.done) count.done += 1;
  }
  return counts;
}

export async function findWorkflowStepOutput(
  db: PostgresConnection,
  input: Input<"findStepOutput">
): Promise<{ value: JsonValue } | undefined> {
  const [row] = await db
    .select({ output: workflowStepRuns.output })
    .from(workflowStepRuns)
    .where(
      and(
        eq(workflowStepRuns.clientInstanceId, input.clientInstanceId),
        eq(workflowStepRuns.runId, input.runId),
        eq(workflowStepRuns.stepId, input.stepId),
        eq(workflowStepRuns.status, "done"),
        input.parentStepRunId === undefined
          ? isNull(workflowStepRuns.parentStepRunId)
          : and(
              eq(workflowStepRuns.parentStepRunId, input.parentStepRunId),
              eq(workflowStepRuns.iteration, input.iteration ?? 0)
            )
      )
    )
    .limit(1);
  return row?.output ?? undefined;
}

export async function countWorkflowLoopItems(
  db: PostgresConnection,
  ref: Input<"countLoopItems">
): Promise<number | undefined> {
  const [row] = await db
    .select({
      count: sql<number | null>`jsonb_array_length(${workflowStepRuns.input}->'items')`
    })
    .from(workflowStepRuns)
    .where(and(stepRunIs(ref), sql`jsonb_typeof(${workflowStepRuns.input}->'items') = 'array'`));
  return row?.count ?? undefined;
}

export async function readWorkflowLoopItem(
  db: PostgresConnection,
  ref: Input<"readLoopItem">
): Promise<{ value: JsonValue } | undefined> {
  const [row] = await db
    .select({
      item: sql<JsonValue>`${workflowStepRuns.input}->'items'->${sql.raw(String(Math.trunc(ref.index)))}`,
      count: sql<number>`jsonb_array_length(${workflowStepRuns.input}->'items')`
    })
    .from(workflowStepRuns)
    .where(and(stepRunIs(ref), sql`jsonb_typeof(${workflowStepRuns.input}->'items') = 'array'`));
  if (!row || ref.index < 0 || ref.index >= row.count) return undefined;
  return { value: row.item };
}

const loopResultsOf = (ref: Input<"listLoopResults">) =>
  and(
    eq(workflowStepRuns.clientInstanceId, ref.clientInstanceId),
    sql`${workflowStepRuns.parentStepRunId} = ${ref.id}`,
    eq(workflowStepRuns.stepId, ref.stepId),
    eq(workflowStepRuns.status, "done")
  );

export async function measureWorkflowLoopResults(
  db: PostgresConnection,
  ref: Input<"measureLoopResults">
): Promise<number> {
  const [row] = await db
    .select({
      bytes: sql<string>`coalesce(sum(octet_length((${workflowStepRuns.output}->'value')::text)), 0)`
    })
    .from(workflowStepRuns)
    .where(loopResultsOf(ref));
  return Number(row?.bytes ?? 0);
}

export async function listWorkflowLoopResults(
  db: PostgresConnection,
  ref: Input<"listLoopResults">
): Promise<JsonValue[]> {
  const rows = await db
    .select({ output: workflowStepRuns.output })
    .from(workflowStepRuns)
    .where(loopResultsOf(ref))
    .orderBy(asc(workflowStepRuns.iteration));
  return rows.map((row) => row.output?.value ?? null);
}
