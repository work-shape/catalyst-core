import { afterEach, describe, expect, it } from "vitest";
import { WORKFLOW_RUN_JOB_KINDS, connectionCallError } from "@work-shape/catalyst-core";
import { child, parent, start as startParent } from "./support/workflow-children";
import { readyChildWorkflows } from "./support/workflow-children-instance";
import { clientInstanceId } from "./support/access-instance";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance, getTestJobs } from "./support/test-instance";
import { withTestSql } from "./support/test-sql";
import {
  publishedDefinitions,
  runSchema,
  type workflowFixture,
  type WorkflowFixture
} from "./support/workflow-instance";
import {
  notifyClients,
  readyWorkflows,
  start,
  stepRunsOf,
  writesOf,
  NOTE
} from "./support/workflow-runs";

// Run data is bounded: a number of days after a run ended, the job `workflow_run.prune_data`
// removes the inputs and outputs of its step runs and the run's own input and result. The run
// and its step runs stay, with status, times, counts and error codes, and the run says when
// its values went. Each test fails on an engine without the job: every value stays for ever.

const DAY_MS = 24 * 60 * 60 * 1_000;
const DAYS = 30;

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});

/** The clock of the engine, which a test moves on by days. */
function clock() {
  let ahead = 0;
  return {
    now: () => new Date(Date.now() + ahead),
    pass(days: number) {
      ahead += days * DAY_MS;
    }
  };
}

const ready = (options: Parameters<typeof workflowFixture>[0]) =>
  readyWorkflows(
    (fixture) => {
      open = fixture;
    },
    { stepDataDays: DAYS, ...options }
  );

/** The run as its page reads it. A failed run carries an error, which is no refusal of the read. */
const readRun = async (t: WorkflowFixture, runId: string) =>
  runSchema.parse((await t.call(t.root.id, "workflows.get_run", { params: { runId } })).json());

/** What the rows of a run still hold of its values. */
const valuesOf = (runId: string) =>
  withTestSql(async (sql) => {
    const [run] = await sql<{ input: unknown; output: unknown }[]>`
      select input, output from workflow_runs where id = ${runId}`;
    const steps = await sql<{ key: string; input: unknown; output: unknown }[]>`
      select key, input, output from workflow_step_runs where run_id = ${runId} order by key`;
    return { run, steps };
  });

describe("the values of a Workflow Run", () => {
  it("go once the run ended longer ago than the limit, in batches, and the record stays", async () => {
    const time = clock();
    const t = await ready({ now: time.now, pruneBatch: { stepRuns: 2 } });
    const run = await t.finish((await start(t)).id);
    expect(run.status).toBe("done");
    const before = await stepRunsOf(t, run.id);
    expect(before.find((stepRun) => stepRun.key === "result")?.outputPreview).toBeDefined();
    expect(before.find((stepRun) => stepRun.key === "clients")?.inputPreview).toBeDefined();

    time.pass(DAYS + 1);
    // Seven step runs carry a value: the trigger, the read, the loop, three sends, the result.
    expect(await t.workflows.pruneRunData()).toEqual({ runs: 1, stepRuns: 7, batches: 4 });

    const values = await valuesOf(run.id);
    expect(values.run).toEqual({ input: {}, output: null });
    expect(values.steps.filter((step) => step.output !== null)).toEqual([]);
    // The loop keeps how many items it had and which step ends an item, and no item.
    expect(values.steps.filter((step) => step.input !== null)).toEqual([
      { key: "each_client", input: { last: "send", total: 3 }, output: null }
    ]);

    const after = await readRun(t, run.id);
    expect(after).toMatchObject({
      id: run.id,
      status: "done",
      stepRunCount: run.stepRunCount,
      finishedAt: run.finishedAt
    });
    expect(after.outputPreview).toBeUndefined();
    expect(Date.parse(after.dataPrunedAt ?? "")).toBeGreaterThan(Date.parse(run.finishedAt ?? ""));
    const stepRuns = await stepRunsOf(t, run.id);
    expect(stepRuns.map(({ id, key, status, attempt }) => ({ id, key, status, attempt }))).toEqual(
      before.map(({ id, key, status, attempt }) => ({ id, key, status, attempt }))
    );
    expect(stepRuns.filter((stepRun) => stepRun.outputPreview)).toEqual([]);
    expect(stepRuns.filter((stepRun) => stepRun.inputPreview)).toEqual([]);
    expect(stepRuns.find((stepRun) => stepRun.key === "each_client")).toMatchObject({
      loop: { total: 3, done: 3, failed: 0, running: 0 },
      bodyCounts: { send: { total: 3, done: 3, failed: 0, running: 0 } }
    });

    // A second run of the job finds nothing.
    expect(await t.workflows.pruneRunData()).toEqual({ runs: 0, stepRuns: 0, batches: 0 });
  });

  it("keeps a done run's key and label filter after pruning so a backfill sends nothing twice", async () => {
    const time = clock();
    const definitions = publishedDefinitions();
    definitions.publish({ ...notifyClients(), labels: { month: { value: "2026-09" } } });
    const t = await ready({ definitions: definitions.source, now: time.now });
    const begin = async () =>
      runSchema.parse(
        (
          await t.expectOk(t.root.id, "workflows.start", {
            params: { workflow: "notify-clients" },
            payload: { input: { note: NOTE }, key: "2026-09/1" }
          })
        ).json()
      );
    const run = await t.finish((await begin()).id);
    const sent = writesOf(t).length;
    expect(sent).toBe(3);
    time.pass(DAYS + 1);
    expect((await t.workflows.pruneRunData()).runs).toBe(1);
    const again = await begin();
    expect(again).toMatchObject({ id: run.id, status: "done" });
    await t.worker().runDue();
    expect(writesOf(t)).toHaveLength(sent);
    const page = await t.expectOk(t.root.id, "workflows.get_run", { params: { runId: run.id } });
    expect(page.json()).toMatchObject({ runKey: "2026-09/1", labels: { month: "2026-09" } });
    // Labels have no public list filter yet. Exercise the persisted label predicate itself.
    await withTestSql(async (sql) => {
      const rows = await sql<{ id: string }[]>`select id from workflow_runs
        where client_instance_id = ${clientInstanceId} and workflow = 'notify-clients'
        and labels @> '{"month":"2026-09"}'::jsonb`;
      expect(rows).toEqual([{ id: run.id }]);
    });
  });

  it("reads reached loop steps and counts after pruning without reconstructing steps that never ran", async () => {
    const time = clock();
    const definitions = publishedDefinitions();
    definitions.publish(
      notifyClients({}, [
        {
          id: "after_send",
          name: "After send",
          type: "operation",
          operation: "connection.crm.write",
          input: { note: { value: "after" } }
        }
      ])
    );
    const t = await ready({ definitions: definitions.source, now: time.now });
    t.setBehaviour((operation) =>
      operation === "echo"
        ? Promise.resolve({ clients: [{ id: "1" }] })
        : Promise.reject(connectionCallError("upstream_conflict"))
    );
    const run = await t.finish((await start(t)).id);
    expect(run.status).toBe("failed");
    const before = (await stepRunsOf(t, run.id)).find((step) => step.stepId === "each_client");
    expect(before?.bodyCounts?.after_send).toEqual({ total: 1, done: 0, failed: 0, running: 0 });
    time.pass(DAYS + 1);
    expect((await t.workflows.pruneRunData()).runs).toBe(1);
    expect(
      await t.stores.workflowRuns.readRunDefinition({ clientInstanceId, id: run.id })
    ).toBeUndefined();
    const after = (await stepRunsOf(t, run.id)).find((step) => step.stepId === "each_client");
    expect(after?.loop).toEqual(before?.loop);
    expect(after?.bodyCounts?.send).toEqual(before?.bodyCounts?.send);
    expect(after?.bodyCounts?.after_send).toBeUndefined();
    expect(after?.concurrency).toBeUndefined();
    expect((await readRun(t, run.id)).dataPrunedAt).toBeDefined();
  });

  it("stay while the run ended less long ago than the limit", async () => {
    const time = clock();
    const t = await ready({ now: time.now });
    const run = await t.finish((await start(t)).id);
    const before = await valuesOf(run.id);

    time.pass(DAYS - 1);
    expect(await t.workflows.pruneRunData()).toEqual({ runs: 0, stepRuns: 0, batches: 0 });
    expect(await valuesOf(run.id)).toEqual(before);
    const after = await readRun(t, run.id);
    expect(after.dataPrunedAt).toBeUndefined();
    expect(after.outputPreview).toEqual(run.outputPreview);
  });

  it("stay while the run has not ended, however old it is, and the run goes on to its end", async () => {
    const time = clock();
    const t = await ready({
      now: time.now,
      limits: { maxDurationMs: 365 * DAY_MS },
      ceilings: { durationMs: 365 * DAY_MS }
    });
    const started = await start(t);
    const worker = t.worker();
    // The trigger, the read, and the loop, which waits for its items.
    for (let pass = 0; pass < 3; pass++) await worker.runDue();
    expect(
      (await stepRunsOf(t, started.id)).find((stepRun) => stepRun.key === "each_client")?.status
    ).toBe("waiting");

    time.pass(DAYS + 10);
    expect(await t.workflows.pruneRunData()).toEqual({ runs: 0, stepRuns: 0, batches: 0 });
    // The same for a run that waits as a whole, as a run does that a later release resumes.
    await withTestSql(
      (sql) => sql`update workflow_runs set status = 'waiting' where id = ${started.id}`
    );
    expect(await t.workflows.pruneRunData()).toEqual({ runs: 0, stepRuns: 0, batches: 0 });
    await withTestSql(
      (sql) => sql`update workflow_runs set status = 'running' where id = ${started.id}`
    );

    // The items read the list the loop kept and the input the trigger handed on.
    const run = await t.finish(started.id, worker);
    expect(run.error).toBeUndefined();
    expect(run.status).toBe("done");
    expect(JSON.parse(run.outputPreview?.text ?? "null")).toEqual({ sent: 3, failed: 0 });
    expect(run.dataPrunedAt).toBeUndefined();
  });

  it("go for a failed run as for one that is done, and its error stays", async () => {
    const time = clock();
    const t = await ready({ now: time.now });
    // Retention needs a terminal failure; a transient read now queues another attempt.
    const failure = connectionCallError("output_invalid");
    t.setBehaviour(() => Promise.reject(failure));
    const run = await t.finish((await start(t)).id);
    expect(run.status).toBe("failed");

    time.pass(DAYS + 1);
    expect((await t.workflows.pruneRunData()).runs).toBe(1);
    const after = await readRun(t, run.id);
    expect(after).toMatchObject({ status: "failed", error: run.error });
    expect(after.dataPrunedAt).toBeDefined();
    const failed = (await stepRunsOf(t, run.id)).filter((stepRun) => stepRun.status === "failed");
    expect(failed.map((stepRun) => stepRun.error?.code)).toEqual([failure.code]);
  });
});

describe("two passes of the job at once", () => {
  // Fails without the change: the second statement met the row the first had pruned and
  // wrote its input as nothing, so the loop read 0 items in most rounds.
  it("leave the rows as one pass does, whichever statement meets a row second", async () => {
    const time = clock();
    // One step run per statement, so every statement of one pass meets one of the other.
    const t = await ready({ now: time.now, pruneBatch: { stepRuns: 1 } });
    const runs: string[] = [];
    for (let round = 0; round < 4; round++) {
      runs.push((await t.finish((await start(t)).id)).id);
    }
    time.pass(DAYS + 1);
    const [first, second] = await Promise.all([
      t.workflows.pruneRunData(),
      t.workflows.pruneRunData()
    ]);
    // Each step run was pruned by one of the two and each run marked by one.
    expect(first.stepRuns + second.stepRuns).toBe(4 * 7);
    expect(first.runs + second.runs).toBe(4);

    for (const runId of runs) {
      const values = await valuesOf(runId);
      expect(values.run).toEqual({ input: {}, output: null });
      expect(values.steps.filter((step) => step.input !== null || step.output !== null)).toEqual([
        { key: "each_client", input: { last: "send", total: 3 }, output: null }
      ]);
      const loop = (await stepRunsOf(t, runId)).find((stepRun) => stepRun.key === "each_client");
      expect(loop?.loop).toEqual({ total: 3, done: 3, failed: 0, running: 0 });
    }
    expect(await t.workflows.pruneRunData()).toEqual({ runs: 0, stepRuns: 0, batches: 0 });
  }, 120_000);

  it("leaves a row a statement pruned as it is when the same statement meets it again", async () => {
    const time = clock();
    const t = await ready({ now: time.now });
    const run = await t.finish((await start(t)).id);
    time.pass(DAYS + 1);
    // The statement of one batch, twice at once on the same rows, 5 rounds: the first
    // round prunes, and every later one meets rows that are pruned already.
    const [id] = await t.stores.workflowRuns.listRunsWithDataEndedBefore({
      clientInstanceId,
      endedBefore: time.now().toISOString(),
      limit: 1
    });
    if (id !== run.id) throw new Error("The run is not due");
    const statement = () =>
      t.stores.workflowRuns.pruneStepRunData({ clientInstanceId, id, limit: 100 });
    for (let round = 0; round < 5; round++) {
      const [one, other] = await Promise.all([statement(), statement()]);
      expect(one + other).toBe(round === 0 ? 7 : 0);
      const values = await valuesOf(run.id);
      expect(values.steps.filter((step) => step.input !== null || step.output !== null)).toEqual([
        { key: "each_client", input: { last: "send", total: 3 }, output: null }
      ]);
    }
  });
});

describe("the job that removes the values of Workflow Runs", () => {
  it("is planned when an instance with the module starts, and not without it", async () => {
    const queued = () =>
      withTestSql(
        (sql) => sql<{ status: string }[]>`
          select status from platform_jobs where kind = ${WORKFLOW_RUN_JOB_KINDS.pruneData}`
      );
    const config = createTestConfig();
    // The worker of a process plans the ticks of its schedules when it asks for its jobs.
    const off = await createTestInstance({ config, tools: [] });
    await getTestJobs(off).runDue();
    expect(await queued()).toEqual([]);
    await off.close();

    const on = await createTestInstance({
      config: { ...config, modules: { ...config.modules, workflows: { enabled: true } } },
      tools: []
    });
    try {
      expect(config.retention.workflowStepDataDays).toBe(DAYS);
      // Due at once: the first pass runs the tick, and the tick of the next day waits.
      await getTestJobs(on).runDue();
      expect((await queued()).map((job) => job.status).sort()).toEqual(["queued", "succeeded"]);
    } finally {
      await on.close();
    }
  });
});

// Independent of the owner's assignments: assert only counts so a failure cannot print a
// retained payload. The owner must cover every schema column before the store is exposed.
async function expectNoValues(ids: string[]) {
  await withTestSql(async (sql) => {
    const [runs] = await sql<{ remaining: number; repaired: number }[]>`
      select count(*) filter (where definition is not null or input <> '{}'::jsonb
        or output is not null or checkpoint is not null or item_label is not null)::int as remaining,
        count(*) filter (where data_prune_version = 4 and data_pruned_at is not null)::int as repaired
      from workflow_runs where id in ${sql(ids)}`;
    const [steps] = await sql<{ remaining: number }[]>`
      select count(*)::int as remaining from workflow_step_runs
      where run_id in ${sql(ids)} and (output is not null or staged is not null
        or code_outcome is not null or log is not null or iteration_label is not null
        or exists (select 1 from jsonb_object_keys(input) field where field not in ('last', 'total')))`;
    expect(runs).toEqual({ remaining: 0, repaired: ids.length });
    expect(steps).toEqual({ remaining: 0 });
  });
}

async function auditCounts(ids: string[]) {
  return withTestSql(
    (sql) => sql<{ type: string; count: number }[]>`
    select type, count(*)::int as count from audit_events
    where subject in ${sql(ids)} or metadata->>'runId' in ${sql(ids)}
    group by type order by type`
  );
}

// Model values left by older workers, including code attempts with no ordinary output.
async function addLegacyValues(id: string) {
  await withTestSql(async (sql) => {
    await sql`update workflow_runs set
      checkpoint = '{"stepId":"each_client","offset":1,"items":["retention-canary"],"completed":{"secret":"retention-canary"}}',
      run_key = 'retention-canary-' || id, labels = '{"customer":"retention-canary"}', item_label = 'retention-canary'
      where id = ${id}`;
    await sql`update workflow_step_runs set output = null, attempt = 3,
      staged = '{"input":{"secret":"retention-canary"},"source":"retention-canary"}',
      code_outcome = '{"output":{"secret":"retention-canary"}}',
      log = '{"stdout":"retention-canary","stderr":"retention-canary","truncated":false}',
      iteration_label = 'retention-canary',
      input = coalesce(input, '{}'::jsonb) || '{"dataset":{"$dataset":"retention-canary"},"future":"retention-canary"}'::jsonb
      where run_id = ${id}`;
  });
}

describe("one retention owner for every Workflow Run value", () => {
  it("requires every run and step schema column to be classified before pruning", async () => {
    // workflowRetention asserts the exhaustive catalog against getTableColumns, including
    // retained columns. An added value column or a dropped owner entry fails this test.
    const t = await ready({});
    expect(await t.workflows.pruneRunData()).toEqual({ runs: 0, stepRuns: 0, batches: 0 });
  });

  it.each(["done", "failed", "cancelled"] as const)(
    "clears all attempts, logs and staged values on a %s run, keeping governance",
    async (status) => {
      const time = clock();
      const t = await ready({ now: time.now, pruneBatch: { runs: 1, stepRuns: 2 } });
      if (status === "failed")
        t.setBehaviour(() => Promise.reject(connectionCallError("output_invalid")));
      const started = await start(t);
      if (status === "cancelled")
        await t.expectOk(t.root.id, "workflows.cancel_run", { params: { runId: started.id } });
      const run =
        status === "cancelled" ? await readRun(t, started.id) : await t.finish(started.id);
      expect(run.status).toBe(status);
      await addLegacyValues(run.id);
      const before = await stepRunsOf(t, run.id);
      const storedRun = await t.stores.workflowRuns.readRun({ clientInstanceId, id: run.id });
      if (!storedRun) throw new Error("Missing stored run");
      // The marker must never hide an unpruned step, even if a caller skips the step pass.
      expect(
        await t.stores.workflowRuns.markRunDataPruned({
          clientInstanceId,
          id: storedRun.id,
          prunedAt: time.now().toISOString()
        })
      ).toBe(false);
      const auditBefore = await auditCounts([run.id]);
      expect(auditBefore.length).toBeGreaterThan(0);
      time.pass(DAYS + 1);
      const totals = await t.workflows.pruneRunData();
      expect(totals).toEqual({
        runs: 1,
        stepRuns: before.length,
        batches: Math.ceil(before.length / 2)
      });
      await expectNoValues([run.id]);
      expect(await auditCounts([run.id])).toEqual(auditBefore);
      expect(await readRun(t, run.id)).toMatchObject({
        status,
        ...(run.error ? { error: run.error } : {}),
        stepRunCount: run.stepRunCount
      });
      expect(
        (await stepRunsOf(t, run.id)).map(({ id, status, attempt }) => ({ id, status, attempt }))
      ).toEqual(before.map(({ id, status, attempt }) => ({ id, status, attempt })));
      expect(await t.workflows.pruneRunData()).toEqual({ runs: 0, stepRuns: 0, batches: 0 });
    }
  );

  it("repairs already marked rows in bounded batches, resumes after interruption, and is safe twice", async () => {
    const time = clock();
    const t = await ready({ now: time.now, pruneBatch: { runs: 1, stepRuns: 2 } });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await t.finish((await start(t)).id)).id);
    const markedAt = time.now().toISOString();
    for (const id of ids) await addLegacyValues(id);
    await withTestSql(
      (sql) => sql`update workflow_runs set data_pruned_at = ${markedAt}, data_prune_version = 0
      where id in ${sql(ids)}`
    );
    // Repair does not wait for today's retention cutoff: these rows already expired.
    const due = await t.stores.workflowRuns.listRunsWithDataEndedBefore({
      clientInstanceId,
      endedBefore: new Date(0).toISOString(),
      limit: 1
    });
    expect(due).toHaveLength(1);
    const id = due[0];
    if (!id) throw new Error("Missing repair candidate");
    expect(await t.stores.workflowRuns.pruneStepRunData({ clientInstanceId, id, limit: 2 })).toBe(
      2
    );
    // Stop after that first batch; the next sweep must pick up the remaining values.
    expect(await t.workflows.pruneRunData()).toEqual({ runs: 3, stepRuns: 19, batches: 11 });
    await expectNoValues(ids);
    await withTestSql(async (sql) => {
      const [row] = await sql<
        { changed: number }[]
      >`select count(*)::int as changed from workflow_runs
        where id in ${sql(ids)} and data_pruned_at <> ${markedAt}::timestamptz`;
      expect(row).toEqual({ changed: 0 });
    });
    expect(await t.workflows.pruneRunData()).toEqual({ runs: 0, stepRuns: 0, batches: 0 });
  });

  it("clears every continued history's checkpoint and values while preserving its links and counts", async () => {
    const time = clock();
    const definitions = publishedDefinitions();
    definitions.publish({
      ...notifyClients({ continueAsNew: { position: "offset", after: 2 } }),
      inputs: {
        type: "object",
        properties: { note: { type: "string" }, offset: { type: "integer" } },
        required: ["note"]
      },
      labels: { customer: { value: "retention-canary" } }
    });
    const t = await ready({ definitions: definitions.source, now: time.now });
    await start(t);
    const worker = t.worker();
    const list = () =>
      t.stores.workflowRuns.listRuns({
        clientInstanceId,
        workflow: "notify-clients",
        page: { limit: 100 }
      });
    for (let pass = 0; pass < 30; pass++) {
      await worker.runDue();
      if ((await list()).some((run) => run.status === "done")) break;
    }
    const before = await list();
    expect(before.map((run) => run.status).sort()).toEqual(["continued", "done"]);
    const ids = before.map((run) => run.id);
    time.pass(DAYS + 1);
    expect((await t.workflows.pruneRunData()).runs).toBe(2);
    await expectNoValues(ids);
    const governance = (runs: typeof before) =>
      runs.map(({ id, status, continuation, stepRunCount, failedItemCount }) => ({
        id,
        status,
        continuation,
        stepRunCount,
        failedItemCount
      }));
    expect(governance(await list())).toEqual(governance(before));
  });

  it("clears child payloads independently and keeps only their governance links", async () => {
    const time = clock();
    const definitions = publishedDefinitions();
    definitions.publish(child());
    definitions.publish(parent());
    const t = await readyChildWorkflows(
      (fixture) => {
        open = fixture;
      },
      definitions,
      { now: time.now }
    );
    const root = await t.finish((await startParent(t)).id);
    expect(root.status).toBe("done");
    const stored = await t.stores.workflowRuns.readRun({ clientInstanceId, id: root.id });
    if (!stored) throw new Error("Missing parent");
    const before = await t.stores.workflowRuns.listChildRuns({ clientInstanceId, id: stored.id });
    expect(before).toHaveLength(1);
    expect(before[0]).toMatchObject({ parentRunId: root.id, status: "done" });
    const ids = [root.id, ...before.map((run) => run.id)];
    for (const id of ids) await addLegacyValues(id);
    time.pass(DAYS + 1);
    expect((await t.workflows.pruneRunData()).runs).toBe(2);
    await expectNoValues(ids);
    const governance = (runs: typeof before) =>
      runs.map(({ id, parentRunId, parentStepRunId, rootRunId, status, depth, stepRunCount }) => ({
        id,
        parentRunId,
        parentStepRunId,
        rootRunId,
        status,
        depth,
        stepRunCount
      }));
    expect(
      governance(await t.stores.workflowRuns.listChildRuns({ clientInstanceId, id: stored.id }))
    ).toEqual(governance(before));
  });
});
