import { lockWorkflowRun, lockWorkflowRunByKey } from "./postgres-workflow-run-lock-order";
import { failedItemCount } from "./postgres-workflow-item-counts";
import { workflowRetention } from "./postgres-workflow-retention";
import { runIsWaiting } from "./postgres-workflow-run-waiting";
import { countWorkflowFailures } from "./postgres-workflow-failure-counts";
import { countWorkflowLoops, listWorkflowStepRuns } from "./postgres-workflow-step-reads";
import {
  createWorkflowRun,
  continuationWorkflowRuns,
  noteLoopStarted,
  noteLoopEnded
} from "./postgres-workflow-continuation";
import { endWorkflowRun } from "./postgres-workflow-run-end";
import { childWorkflowRuns } from "./postgres-workflow-child-operations";
import {
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
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  WORKFLOW_ENDED_STATUSES,
  type JsonObject,
  type JsonValue,
  type WorkflowCodeOutcome,
  type WorkflowLastRun,
  type WorkflowLoopCounts,
  type WorkflowManifest,
  type WorkflowRun,
  type WorkflowRunsStore,
  type WorkflowRunView,
  type WorkflowStagedCode,
  type WorkflowStepRun,
  type WorkflowStepRunId
} from "@work-shape/catalyst-core";
import { keysetFilter } from "./paging";
import { type PostgresConnection } from "./postgres-database";
import { workflowRuns, workflowStepRuns } from "./schema/workflowRuns";

type Input<Method extends keyof WorkflowRunsStore> = Parameters<WorkflowRunsStore[Method]>[0];

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
  // Held until the caller commits the run insertion: different due times share admission.
  const key = `workflow-schedule:${input.clientInstanceId}:${input.workflow}`;
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
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
  if (!row) return undefined;
  return { ...mapRun(row), ...mapPreview(row.preview) };
}

async function readWorkflowRunView(
  db: PostgresConnection,
  input: Input<"readRunView">
): Promise<WorkflowRunView | undefined> {
  const run = await readWorkflowRun(db, input);
  if (!run) return undefined;
  const counts = await countWorkflowFailures(db, {
    clientInstanceId: input.clientInstanceId,
    runIds: [run.id]
  });
  return { ...run, failedDescendantCount: counts.get(run.id) ?? 0 };
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
  const counts = await countWorkflowFailures(db, {
    clientInstanceId: input.clientInstanceId,
    runIds: rows.map((row) => row.id)
  });
  return rows.map((row) => ({
    ...mapRun(row),
    ...mapPreview(row.preview),
    failedDescendantCount: counts.get(row.id) ?? 0
  }));
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
      failedItemCount: workflowRuns.failedItemCount,
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
  const counts = await countWorkflowFailures(db, {
    clientInstanceId: input.clientInstanceId,
    runIds: rows.map((row) => row.id)
  });
  for (const row of rows) {
    last.set(row.workflow, {
      id: row.id,
      status: row.status,
      failedDescendantCount: counts.get(row.id) ?? 0,
      ...(row.failedItemCount === null ? {} : { failedItemCount: row.failedItemCount }),
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
  return row?.definition ?? undefined;
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
  await noteLoopStarted(db, row);
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
    .returning(stepRunColumns);
  if (ended[0]) {
    await noteLoopEnded(db, ended[0]);
    // Cancellation leaves running attempts to record their real outcome. The terminal
    // run's original count predates this failure; refresh it behind the same run lock.
    if (ref.status === "failed")
      await db
        .update(workflowRuns)
        .set({ failedItemCount })
        .where(
          and(
            runIs({ clientInstanceId: ref.clientInstanceId, id: ended[0].runId }),
            inArray(workflowRuns.status, [...WORKFLOW_ENDED_STATUSES])
          )
        );
  }
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
        started: 0,
        ended: 0,
        ...(ref.firstStepId === undefined ? {} : { first: ref.firstStepId }),
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

export function createPostgresWorkflowRunsStore(db: PostgresConnection): WorkflowRunsStore {
  return {
    ...childWorkflowRuns(db),
    ...workflowRetention(db),
    ...continuationWorkflowRuns(db),
    createRun: (run) => createWorkflowRun(db, run),
    lockRunByKey: (input) => lockWorkflowRunByKey(db, input),
    linkStepRun: (ref) => linkWorkflowStepRun(db, ref),
    listLinkedStepRuns: (ref) => listLinkedWorkflowStepRuns(db, ref),
    readScheduleState: (input) => readWorkflowScheduleState(db, input),
    countLoopItemsStarted: (ref) => countWorkflowLoopItemsStarted(db, ref),
    recordStepRunInput: async (ref) => {
      await db
        .update(workflowStepRuns)
        .set({
          input: sql`coalesce(${workflowStepRuns.input}, '{}'::jsonb) || ${JSON.stringify({ value: ref.input })}::jsonb`
        })
        .where(and(stepRunIs(ref), eq(workflowStepRuns.status, "running")));
    },
    stageCodeStep: (ref) => stageWorkflowCodeStep(db, ref),
    readStagedCode: (ref) => readWorkflowStagedCode(db, ref),
    recordCodeOutcome: (ref) => recordWorkflowCodeOutcome(db, ref),
    readCodeOutcome: (ref) => readWorkflowCodeOutcome(db, ref),
    lockRun: (ref) => lockWorkflowRun(db, ref),
    markRunWaiting: (ref) => markWorkflowRunWaiting(db, ref),
    endRunWait: (ref) => endWorkflowRunWait(db, ref),
    readRun: (input) => readWorkflowRun(db, input),
    readRunView: (input) => readWorkflowRunView(db, input),
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
    listStepRuns: (input) => listWorkflowStepRuns(db, input),
    findStepOutput: (input) => findWorkflowStepOutput(db, input),
    countLoopItems: (ref) => countWorkflowLoopItems(db, ref),
    readLoopItem: (ref) => readWorkflowLoopItem(db, ref),
    readLoopCounts: (ref) => readWorkflowLoopCounts(db, ref)
  };
}

export { createPostgresWorkflowRunDatasetsStore } from "./postgres-workflow-datasets";
