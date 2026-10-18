import { runIsWaiting } from "./postgres-workflow-run-waiting";
import { endWorkflowRun } from "./postgres-workflow-run-end";
import { childWorkflowRuns } from "./postgres-workflow-child-operations";
import {
  stepPreview,
  runColumns,
  stepRunColumns,
  previewOf,
  mapPreview,
  mapRun,
  mapStepRun,
  runIs,
  stepRunIs,
  notEnded
} from "./postgres-workflow-run-mapping";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, notInArray, sql } from "drizzle-orm";
import {
  WORKFLOW_ENDED_STATUSES,
  WORKFLOW_KEY_RELEASING_STATUSES,
  type JsonObject,
  type JsonValue,
  type WorkflowBodyCounts,
  type WorkflowCodeOutcome,
  type WorkflowLastRun,
  type WorkflowLoopCounts,
  type WorkflowManifest,
  type WorkflowRun,
  type WorkflowRunId,
  type WorkflowRunsStore,
  type WorkflowRunView,
  type WorkflowStagedCode,
  type WorkflowStepRun,
  type WorkflowStepRunId,
  type WorkflowStepRunView
} from "@work-shape/catalyst-core";
import { keysetFilter } from "./paging";
import { type PostgresConnection } from "./postgres-database";
import { workflowRuns, workflowStepRuns } from "./schema/workflowRuns";

type Input<Method extends keyof WorkflowRunsStore> = Parameters<WorkflowRunsStore[Method]>[0];

async function createWorkflowRun(
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
      rootRunId: run.rootRunId ?? run.id,
      depth: run.depth ?? 0,
      parentRunId: run.parentRunId ?? null,
      parentStepRunId: run.parentStepRunId ?? null,
      itemIndex: run.itemIndex ?? null,
      itemLabel: run.itemLabel ?? null,
      operationRunId: run.operationRunId ?? null,
      deadlineAt: new Date(run.deadlineAt),
      limits: run.limits,
      correlationId: run.correlationId,
      createdAt: new Date(run.createdAt),
      scheduledFor: run.scheduledFor === undefined ? null : new Date(run.scheduledFor),
      runKey: run.runKey ?? null
    })
    // The conflicts a new id can meet: the due time of a schedule that has its run, the run
    // key of an open or done run, and the Operation Run of a start that wrote its run. An
    // insert that meets a key another start has written and not committed waits for it.
    .onConflictDoNothing()
    .returning(runColumns);
  return row ? mapRun(row) : undefined;
}

async function lockWorkflowRunByKey(
  db: PostgresConnection,
  input: Input<"lockRunByKey">
): Promise<WorkflowRun | undefined> {
  // The predicate of `workflow_runs_run_key_idx`: the run that holds the key, read again
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
    .for("update");
  return row ? mapRun(row) : undefined;
}

async function linkWorkflowStepRun(
  db: PostgresConnection,
  ref: Input<"linkStepRun">
): Promise<void> {
  await db
    .update(workflowStepRuns)
    .set({ linkedRunId: ref.linkedRunId })
    .where(and(stepRunIs(ref), notEnded(workflowStepRuns.status)));
}

async function listLinkedWorkflowStepRuns(
  db: PostgresConnection,
  ref: Input<"listLinkedStepRuns">
): Promise<WorkflowStepRunId[]> {
  const rows = await db
    .select({ id: workflowStepRuns.id })
    .from(workflowStepRuns)
    .where(
      and(
        eq(workflowStepRuns.clientInstanceId, ref.clientInstanceId),
        eq(workflowStepRuns.linkedRunId, ref.id),
        notEnded(workflowStepRuns.status)
      )
    );
  return rows.map((row) => row.id);
}

async function readWorkflowScheduleState(
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

async function lockWorkflowRun(
  db: PostgresConnection,
  ref: Input<"lockRun">
): Promise<WorkflowRun | undefined> {
  const [row] = await db.select(runColumns).from(workflowRuns).where(runIs(ref)).for("update");
  return row ? mapRun(row) : undefined;
}

async function markWorkflowRunWaiting(
  db: PostgresConnection,
  ref: Input<"markRunWaiting">
): Promise<boolean> {
  const rows = await db
    .update(workflowRuns)
    .set({ waitingSince: new Date(ref.at) })
    .where(
      and(
        runIs(ref),
        notEnded(workflowRuns.status),
        isNull(workflowRuns.waitingSince),
        runIsWaiting(ref)
      )
    )
    .returning({ id: workflowRuns.id });
  return rows.length > 0;
}

async function endWorkflowRunWait(
  db: PostgresConnection,
  ref: Input<"endRunWait">
): Promise<WorkflowRun | undefined> {
  // The wait is never negative: a clock that went back ends it at its start.
  const waited = sql`greatest(${ref.at}::timestamptz - ${workflowRuns.waitingSince}, interval '0')`;
  const [row] = await db
    .update(workflowRuns)
    .set({
      deadlineAt: sql`${workflowRuns.deadlineAt} + ${waited}`,
      waitedMs: sql`${workflowRuns.waitedMs} + floor(extract(epoch from ${waited}) * 1000)::bigint`,
      waitingSince: null
    })
    .where(and(runIs(ref), isNotNull(workflowRuns.waitingSince)))
    .returning(runColumns);
  return row ? mapRun(row) : undefined;
}

async function readWorkflowRun(
  db: PostgresConnection,
  input: Input<"readRun">
): Promise<WorkflowRunView | undefined> {
  const [row] = await db
    .select({ ...runColumns, preview: previewOf(workflowRuns.output) })
    .from(workflowRuns)
    .where(runIs(input));
  return row ? { ...mapRun(row), ...mapPreview(row.preview) } : undefined;
}

async function listWorkflowRuns(
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
        input.key === undefined
          ? undefined
          : "exact" in input.key
            ? eq(workflowRuns.runKey, input.key.exact)
            : // `starts_with` takes the prefix as it is written: `_` and `%` are no patterns.
              sql`starts_with(${workflowRuns.runKey}, ${input.key.prefix})`,
        keysetFilter(input.page, [workflowRuns.createdAt, workflowRuns.id], true)
      )
    )
    .orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.id))
    .limit(input.page?.limit ?? 2147483647);
  return rows.map((row) => ({ ...mapRun(row), ...mapPreview(row.preview) }));
}

async function listLastWorkflowRuns(
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

async function readWorkflowRunDefinition(
  db: PostgresConnection,
  input: Input<"readRunDefinition">
): Promise<WorkflowManifest | undefined> {
  const [row] = await db
    .select({ definition: workflowRuns.definition })
    .from(workflowRuns)
    .where(runIs(input));
  return row?.definition;
}

async function readWorkflowRunInput(
  db: PostgresConnection,
  ref: Input<"readRunInput">
): Promise<JsonObject | undefined> {
  const [row] = await db.select({ input: workflowRuns.input }).from(workflowRuns).where(runIs(ref));
  return row?.input;
}

async function markWorkflowRunRunning(
  db: PostgresConnection,
  ref: Input<"markRunRunning">
): Promise<void> {
  await db
    .update(workflowRuns)
    .set({ status: "running", startedAt: new Date(ref.startedAt) })
    .where(and(runIs(ref), eq(workflowRuns.status, "queued")));
}

async function createWorkflowStepRun(
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

async function getWorkflowStepRun(
  db: PostgresConnection,
  ref: Input<"getStepRun">
): Promise<WorkflowStepRun | undefined> {
  const [row] = await db.select(stepRunColumns).from(workflowStepRuns).where(stepRunIs(ref));
  return row ? mapStepRun(row) : undefined;
}

async function markWorkflowStepRunRunning(
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

async function endWorkflowStepRun(
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
      ...(ref.call?.target === undefined ? {} : { target: ref.call.target }),
      ...(ref.call?.publishedWouldAsk === undefined
        ? {}
        : { publishedWouldAsk: ref.call.publishedWouldAsk }),
      error: ref.error ?? null
    })
    .where(and(stepRunIs(ref), notEnded(workflowStepRuns.status)))
    .returning({ id: workflowStepRuns.id });
  return ended.length > 0;
}

async function markWorkflowLoopWaiting(
  db: PostgresConnection,
  ref: Input<"markLoopWaiting">
): Promise<void> {
  await db
    .update(workflowStepRuns)
    .set({
      status: "waiting",
      input: {
        ...("$dataset" in ref.items
          ? { dataset: ref.items, total: ref.total ?? ref.items.rowCount }
          : { items: [...ref.items] }),
        ...(ref.lastStepId === undefined ? {} : { last: ref.lastStepId })
      }
    })
    .where(and(stepRunIs(ref), eq(workflowStepRuns.status, "running")));
}

async function stageWorkflowCodeStep(
  db: PostgresConnection,
  ref: Input<"stageCodeStep">
): Promise<void> {
  await db
    .update(workflowStepRuns)
    .set({ status: "waiting", staged: ref.staged, codeOutcome: null })
    .where(and(stepRunIs(ref), eq(workflowStepRuns.status, "running")));
}

async function readWorkflowStagedCode(
  db: PostgresConnection,
  ref: Input<"readStagedCode">
): Promise<WorkflowStagedCode | undefined> {
  const [row] = await db
    .select({ staged: workflowStepRuns.staged })
    .from(workflowStepRuns)
    .where(and(stepRunIs(ref), eq(workflowStepRuns.status, "waiting")));
  return row?.staged ?? undefined;
}

async function recordWorkflowCodeOutcome(
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

async function readWorkflowCodeOutcome(
  db: PostgresConnection,
  ref: Input<"readCodeOutcome">
): Promise<WorkflowCodeOutcome | undefined> {
  const [row] = await db
    .select({ outcome: workflowStepRuns.codeOutcome })
    .from(workflowStepRuns)
    .where(stepRunIs(ref));
  return row?.outcome ?? undefined;
}

async function noteWorkflowStepRunOperation(
  db: PostgresConnection,
  ref: Input<"noteStepRunOperation">
): Promise<void> {
  await db
    .update(workflowStepRuns)
    .set({ operationRunId: ref.operationRunId })
    .where(and(stepRunIs(ref), notEnded(workflowStepRuns.status)));
}

async function listOpenWorkflowStepRuns(
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

async function listWorkflowStepRuns(
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

async function findWorkflowStepOutput(
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

async function countWorkflowLoopItemsStarted(
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

async function countWorkflowLoopItems(
  db: PostgresConnection,
  ref: Input<"countLoopItems">
): Promise<number | undefined> {
  const [row] = await db
    .select({
      count: sql<
        number | null
      >`coalesce((${workflowStepRuns.input}->>'total')::int, jsonb_array_length(${workflowStepRuns.input}->'items'))`
    })
    .from(workflowStepRuns)
    .where(stepRunIs(ref));
  return row?.count ?? undefined;
}

async function readWorkflowLoopItem(
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

async function readWorkflowLoopCounts(
  db: PostgresConnection,
  ref: Input<"readLoopCounts">
): Promise<WorkflowLoopCounts | undefined> {
  const [row] = await db
    .select({ id: workflowStepRuns.id })
    .from(workflowStepRuns)
    .where(stepRunIs(ref));
  return row ? (await countWorkflowLoops(db, [row.id])).get(row.id) : undefined;
}

async function listWorkflowRunsWithDataEndedBefore(
  db: PostgresConnection,
  input: Input<"listRunsWithDataEndedBefore">
): Promise<WorkflowRunId[]> {
  const rows = await db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.clientInstanceId, input.clientInstanceId),
        isNull(workflowRuns.dataPrunedAt),
        isNotNull(workflowRuns.finishedAt),
        lt(workflowRuns.finishedAt, new Date(input.endedBefore)),
        inArray(workflowRuns.status, [...WORKFLOW_ENDED_STATUSES])
      )
    )
    .orderBy(asc(workflowRuns.finishedAt))
    .limit(input.limit);
  return rows.map((row) => row.id);
}

async function pruneWorkflowStepRunData(
  db: PostgresConnection,
  ref: Input<"pruneStepRunData">
): Promise<number> {
  // A step run still has a value while it has an output or, a loop, its list. The rows of one
  // batch are locked for one short statement and no other row of the table is.
  const hasValue = sql`(${workflowStepRuns.output} is not null or ${workflowStepRuns.input} ? 'items')`;
  const due = db
    .select({ id: workflowStepRuns.id })
    .from(workflowStepRuns)
    .where(
      and(
        eq(workflowStepRuns.clientInstanceId, ref.clientInstanceId),
        sql`${workflowStepRuns.runId} = ${ref.id}`,
        hasValue
      )
    )
    .limit(ref.limit);
  const pruned = await db
    .update(workflowStepRuns)
    .set({
      output: null,
      // What a loop keeps is made from its list alone. A row without a list is one whose list
      // went already, or no loop: it keeps the input it has, which no statement here derives
      // from a value it removed.
      input: sql`case when jsonb_typeof(${workflowStepRuns.input}->'items') = 'array'
        then jsonb_strip_nulls(jsonb_build_object(
          'last', ${workflowStepRuns.input}->'last',
          'total', jsonb_array_length(${workflowStepRuns.input}->'items')))
        else ${workflowStepRuns.input} end`
    })
    // Asked again of the row as it is when this statement holds it: a row that another
    // statement pruned while this one waited for it is no longer one with a value.
    .where(and(inArray(workflowStepRuns.id, due), hasValue))
    .returning({ id: workflowStepRuns.id });
  return pruned.length;
}

async function markWorkflowRunDataPruned(
  db: PostgresConnection,
  ref: Input<"markRunDataPruned">
): Promise<boolean> {
  const pruned = await db
    .update(workflowRuns)
    .set({ input: {}, output: null, dataPrunedAt: new Date(ref.prunedAt) })
    .where(
      and(
        runIs(ref),
        isNull(workflowRuns.dataPrunedAt),
        inArray(workflowRuns.status, [...WORKFLOW_ENDED_STATUSES])
      )
    )
    .returning({ id: workflowRuns.id });
  return pruned.length > 0;
}

export function createPostgresWorkflowRunsStore(db: PostgresConnection): WorkflowRunsStore {
  return {
    ...childWorkflowRuns(db),
    createRun: (run) => createWorkflowRun(db, run),
    lockRunByKey: (input) => lockWorkflowRunByKey(db, input),
    linkStepRun: (ref) => linkWorkflowStepRun(db, ref),
    listLinkedStepRuns: (ref) => listLinkedWorkflowStepRuns(db, ref),
    readScheduleState: (input) => readWorkflowScheduleState(db, input),
    countLoopItemsStarted: (ref) => countWorkflowLoopItemsStarted(db, ref),
    stageCodeStep: (ref) => stageWorkflowCodeStep(db, ref),
    readStagedCode: (ref) => readWorkflowStagedCode(db, ref),
    recordCodeOutcome: (ref) => recordWorkflowCodeOutcome(db, ref),
    readCodeOutcome: (ref) => readWorkflowCodeOutcome(db, ref),
    lockRun: (ref) => lockWorkflowRun(db, ref),
    markRunWaiting: (ref) => markWorkflowRunWaiting(db, ref),
    endRunWait: (ref) => endWorkflowRunWait(db, ref),
    readRun: (input) => readWorkflowRun(db, input),
    listRuns: (input) => listWorkflowRuns(db, input),
    listLastRuns: (input) => listLastWorkflowRuns(db, input),
    readRunInput: (ref) => readWorkflowRunInput(db, ref),
    readRunDefinition: (input) => readWorkflowRunDefinition(db, input),
    markRunRunning: (ref) => markWorkflowRunRunning(db, ref),
    endRun: (ref) => endWorkflowRun(db, ref),
    createStepRun: (stepRun) => createWorkflowStepRun(db, stepRun),
    getStepRun: (ref) => getWorkflowStepRun(db, ref),
    markStepRunRunning: (ref) => markWorkflowStepRunRunning(db, ref),
    endStepRun: (ref) => endWorkflowStepRun(db, ref),
    async readLoopDataset(ref) {
      const [row] = await db
        .select({ input: workflowStepRuns.input })
        .from(workflowStepRuns)
        .where(stepRunIs(ref));
      return row?.input?.dataset;
    },
    markLoopWaiting: (ref) => markWorkflowLoopWaiting(db, ref),
    noteStepRunOperation: (ref) => noteWorkflowStepRunOperation(db, ref),
    listOpenStepRuns: (ref) => listOpenWorkflowStepRuns(db, ref),
    listRunsWithDataEndedBefore: (input) => listWorkflowRunsWithDataEndedBefore(db, input),
    pruneStepRunData: (ref) => pruneWorkflowStepRunData(db, ref),
    markRunDataPruned: (ref) => markWorkflowRunDataPruned(db, ref),
    listStepRuns: (input) => listWorkflowStepRuns(db, input),
    findStepOutput: (input) => findWorkflowStepOutput(db, input),
    countLoopItems: (ref) => countWorkflowLoopItems(db, ref),
    readLoopItem: (ref) => readWorkflowLoopItem(db, ref),
    readLoopCounts: (ref) => readWorkflowLoopCounts(db, ref)
  };
}

export { createPostgresWorkflowRunDatasetsStore } from "./postgres-workflow-datasets";
