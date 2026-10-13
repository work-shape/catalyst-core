import { and, asc, desc, eq, getTableColumns, inArray, isNull, notInArray, sql } from "drizzle-orm";
import {
  WORKFLOW_ENDED_STATUSES,
  WORKFLOW_OUTPUT_PREVIEW_MAX_CHARS,
  type JsonObject,
  type JsonValue,
  type WorkflowBodyCounts,
  type WorkflowCodeOutcome,
  type WorkflowLastRun,
  type WorkflowLoopCounts,
  type WorkflowManifest,
  type WorkflowOutputPreview,
  type WorkflowRun,
  type WorkflowRunsStore,
  type WorkflowRunView,
  type WorkflowStagedCode,
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
// The definition a run keeps is among them: it is as large as a file may be, and a step
// reads it once.
const {
  input: _runInput,
  output: _runOutput,
  definition: _runDefinition,
  ...runColumns
} = getTableColumns(workflowRuns);
const {
  input: _stepInput,
  output: _stepOutput,
  // The script and the input of a code step, its raw outcome and its log are read where
  // they are needed and not with every step run.
  staged: _stepStaged,
  codeOutcome: _stepCodeOutcome,
  log: _stepLog,
  ...stepRunColumns
} = getTableColumns(workflowStepRuns);

// One character more than a preview shows, so a cut value is told from one that just fits.
const previewOf = (column: typeof workflowRuns.output | typeof workflowStepRuns.output) =>
  sql<
    string | null
  >`left((${column}->'value')::text, ${sql.raw(String(WORKFLOW_OUTPUT_PREVIEW_MAX_CHARS + 1))})`;

// The output of a trigger step is the run's input, and a read never answers an input.
const stepPreview = sql<
  string | null
>`case when ${workflowStepRuns.stepType} = 'trigger' then null else ${previewOf(workflowStepRuns.output)} end`;

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

function mapRun(row: Omit<RunRow, "input" | "output" | "definition">): WorkflowRun {
  return {
    id: row.id,
    clientInstanceId: row.clientInstanceId,
    workflow: row.workflow,
    definitionRevisionId: row.definitionRevisionId,
    mode: row.mode,
    trigger: row.trigger,
    status: row.status,
    principal: { id: row.principalId, name: row.principalName, displayLabel: row.principalLabel },
    startedBy: row.startedBy,
    ...(row.operationRunId === null ? {} : { operationRunId: row.operationRunId }),
    stepRunCount: row.stepRunCount,
    deadlineAt: row.deadlineAt.toISOString(),
    ...(row.error === null ? {} : { error: row.error }),
    correlationId: row.correlationId,
    createdAt: row.createdAt.toISOString(),
    ...(row.startedAt === null ? {} : { startedAt: row.startedAt.toISOString() }),
    ...(row.finishedAt === null ? {} : { finishedAt: row.finishedAt.toISOString() }),
    ...(row.cancelledBy === null ? {} : { cancelledBy: row.cancelledBy }),
    ...(row.cancelledAt === null ? {} : { cancelledAt: row.cancelledAt.toISOString() }),
    ...(row.scheduledFor === null ? {} : { scheduledFor: row.scheduledFor.toISOString() })
  };
}

function mapStepRun(
  row: Omit<StepRunRow, "input" | "output" | "staged" | "codeOutcome" | "log">
): WorkflowStepRun {
  return {
    id: row.id,
    clientInstanceId: row.clientInstanceId,
    runId: row.runId,
    stepId: row.stepId,
    stepType: row.stepType,
    key: row.key,
    ...(row.containerStepRunId === null ? {} : { containerStepRunId: row.containerStepRunId }),
    ...(row.branch === null ? {} : { branch: row.branch }),
    ...(row.iteration === null
      ? {}
      : {
          iteration: {
            index: row.iteration,
            ...(row.iterationLabel === null ? {} : { label: row.iterationLabel })
          }
        }),
    status: row.status,
    attempt: row.attempt,
    ...(row.operationRunId === null ? {} : { operationRunId: row.operationRunId }),
    ...(row.effect === null ? {} : { effect: row.effect }),
    ...(row.source === null ? {} : { source: row.source }),
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
      principalId: run.principal.id,
      principalName: run.principal.name,
      principalLabel: run.principal.displayLabel,
      startedBy: run.startedBy,
      operationRunId: run.operationRunId ?? null,
      deadlineAt: new Date(run.deadlineAt),
      correlationId: run.correlationId,
      createdAt: new Date(run.createdAt),
      scheduledFor: run.scheduledFor === undefined ? null : new Date(run.scheduledFor)
    })
    // The one conflict a new id can meet is the due time of a schedule that has its run.
    .onConflictDoNothing()
    .returning(runColumns);
  return row ? mapRun(row) : undefined;
}

export async function readWorkflowScheduleState(
  db: PostgresConnection,
  input: Input<"readScheduleState">
): Promise<{ fired: boolean; open: boolean }> {
  const [row] = await db
    .select({
      fired: sql<boolean>`coalesce(bool_or(${workflowRuns.scheduledFor} = ${input.scheduledFor}::timestamptz), false)`,
      open: sql<boolean>`coalesce(bool_or(${workflowRuns.status} in ('queued', 'running', 'waiting')), false)`
    })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.clientInstanceId, input.clientInstanceId),
        eq(workflowRuns.workflow, input.workflow),
        eq(workflowRuns.trigger, "schedule")
      )
    );
  return { fired: row?.fired ?? false, open: row?.open ?? false };
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
  return row ? { ...mapRun(row), ...mapPreview(row.preview) } : undefined;
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
  return rows.map((row) => ({ ...mapRun(row), ...mapPreview(row.preview) }));
}

export async function listLastWorkflowRuns(
  db: PostgresConnection,
  input: Input<"listLastRuns">
): Promise<Map<string, WorkflowLastRun>> {
  const last = new Map<string, WorkflowLastRun>();
  if (input.workflows.length === 0) return last;
  const rows = await db
    .selectDistinctOn([workflowRuns.workflow], {
      workflow: workflowRuns.workflow,
      id: workflowRuns.id,
      status: workflowRuns.status,
      startedAt: workflowRuns.startedAt,
      finishedAt: workflowRuns.finishedAt
    })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.clientInstanceId, input.clientInstanceId),
        inArray(workflowRuns.workflow, [...input.workflows])
      )
    )
    .orderBy(workflowRuns.workflow, desc(workflowRuns.createdAt), desc(workflowRuns.id));
  for (const row of rows) {
    last.set(row.workflow, {
      id: row.id,
      status: row.status,
      ...(row.startedAt === null ? {} : { startedAt: row.startedAt.toISOString() }),
      ...(row.finishedAt === null ? {} : { endedAt: row.finishedAt.toISOString() })
    });
  }
  return last;
}

export async function readWorkflowRunDefinition(
  db: PostgresConnection,
  input: Input<"readRunDefinition">
): Promise<WorkflowManifest | undefined> {
  const [row] = await db
    .select({ definition: workflowRuns.definition })
    .from(workflowRuns)
    .where(runIs(input));
  return row?.definition;
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
      error: ref.error ?? null,
      ...(ref.status === "cancelled"
        ? { cancelledBy: ref.cancelledBy ?? null, cancelledAt: new Date(ref.finishedAt) }
        : {})
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
      containerStepRunId: stepRun.containerStepRunId ?? null,
      branch: stepRun.branch ?? null,
      iteration: stepRun.iteration?.index ?? null,
      iterationLabel: stepRun.iteration?.label ?? null,
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
      ...(ref.call?.effect === undefined ? {} : { effect: ref.call.effect }),
      ...(ref.call?.source === undefined ? {} : { source: ref.call.source }),
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
    .set({
      status: "waiting",
      input: {
        items: [...ref.items],
        ...(ref.lastStepId === undefined ? {} : { last: ref.lastStepId })
      }
    })
    .where(and(stepRunIs(ref), eq(workflowStepRuns.status, "running")));
}

export async function stageWorkflowCodeStep(
  db: PostgresConnection,
  ref: Input<"stageCodeStep">
): Promise<void> {
  await db
    .update(workflowStepRuns)
    .set({ status: "waiting", staged: ref.staged, codeOutcome: null })
    .where(and(stepRunIs(ref), eq(workflowStepRuns.status, "running")));
}

export async function readWorkflowStagedCode(
  db: PostgresConnection,
  ref: Input<"readStagedCode">
): Promise<WorkflowStagedCode | undefined> {
  const [row] = await db
    .select({ staged: workflowStepRuns.staged })
    .from(workflowStepRuns)
    .where(and(stepRunIs(ref), eq(workflowStepRuns.status, "waiting")));
  return row?.staged ?? undefined;
}

export async function recordWorkflowCodeOutcome(
  db: PostgresConnection,
  ref: Input<"recordCodeOutcome">
): Promise<boolean> {
  const recorded = await db
    .update(workflowStepRuns)
    .set({ staged: null, codeOutcome: ref.outcome, log: ref.log })
    .where(
      and(
        stepRunIs(ref),
        eq(workflowStepRuns.status, "waiting"),
        sql`${workflowStepRuns.staged} is not null`
      )
    )
    .returning({ id: workflowStepRuns.id });
  return recorded.length > 0;
}

export async function readWorkflowCodeOutcome(
  db: PostgresConnection,
  ref: Input<"readCodeOutcome">
): Promise<WorkflowCodeOutcome | undefined> {
  const [row] = await db
    .select({ outcome: workflowStepRuns.codeOutcome })
    .from(workflowStepRuns)
    .where(stepRunIs(ref));
  return row?.outcome ?? undefined;
}

export async function noteWorkflowStepRunOperation(
  db: PostgresConnection,
  ref: Input<"noteStepRunOperation">
): Promise<void> {
  await db
    .update(workflowStepRuns)
    .set({ operationRunId: ref.operationRunId })
    .where(and(stepRunIs(ref), notEnded(workflowStepRuns.status)));
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
  const { filter } = input;
  const rows = await db
    .select({ ...stepRunColumns, preview: stepPreview, log: workflowStepRuns.log })
    .from(workflowStepRuns)
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
async function countWorkflowLoops(
  db: PostgresConnection,
  loopStepRunIds: WorkflowStepRunId[]
): Promise<Map<string, WorkflowLoopCounts>> {
  const counts = new Map<string, WorkflowLoopCounts>();
  if (loopStepRunIds.length === 0) return counts;
  const totals = await db
    .select({
      id: workflowStepRuns.id,
      last: sql<string | null>`${workflowStepRuns.input}->>'last'`,
      total: sql<number>`coalesce(jsonb_array_length(${workflowStepRuns.input}->'items'), 0)::int`
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
        input.containerStepRunId === undefined
          ? isNull(workflowStepRuns.containerStepRunId)
          : and(
              eq(workflowStepRuns.containerStepRunId, input.containerStepRunId),
              eq(workflowStepRuns.iteration, input.iteration ?? 0)
            )
      )
    )
    .limit(1);
  return row?.output ?? undefined;
}

export async function countWorkflowLoopItemsStarted(
  db: PostgresConnection,
  ref: Input<"countLoopItemsStarted">
): Promise<number> {
  const [row] = await db
    .select({ started: sql<number>`coalesce(max(${workflowStepRuns.iteration}) + 1, 0)::int` })
    .from(workflowStepRuns)
    .where(
      and(
        eq(workflowStepRuns.clientInstanceId, ref.clientInstanceId),
        sql`${workflowStepRuns.containerStepRunId} = ${ref.id}`
      )
    );
  return row?.started ?? 0;
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

export async function readWorkflowLoopCounts(
  db: PostgresConnection,
  ref: Input<"readLoopCounts">
): Promise<WorkflowLoopCounts | undefined> {
  const [row] = await db
    .select({ id: workflowStepRuns.id })
    .from(workflowStepRuns)
    .where(stepRunIs(ref));
  return row ? (await countWorkflowLoops(db, [row.id])).get(row.id) : undefined;
}
