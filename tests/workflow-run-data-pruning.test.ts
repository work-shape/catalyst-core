import { afterEach, describe, expect, it } from "vitest";
import { WORKFLOW_RUN_JOB_KINDS } from "@vivd-catalyst/core";
import { clientInstanceId } from "./support/access-instance";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance, getTestJobs } from "./support/test-instance";
import { withTestSql } from "./support/test-sql";
import { runSchema, type workflowFixture, type WorkflowFixture } from "./support/workflow-instance";
import { readyWorkflows, start, stepRunsOf } from "./support/workflow-runs";

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
    expect(stepRuns.find((stepRun) => stepRun.key === "each_client")).toMatchObject({
      loop: { total: 3, done: 3, failed: 0, running: 0 },
      bodyCounts: { send: { total: 3, done: 3, failed: 0, running: 0 } }
    });

    // A second run of the job finds nothing.
    expect(await t.workflows.pruneRunData()).toEqual({ runs: 0, stepRuns: 0, batches: 0 });
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
    const t = await ready({ now: time.now, limits: { maxDurationMs: 365 * DAY_MS } });
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
    t.setBehaviour(() => Promise.reject(new Error("The outside system is down")));
    const run = await t.finish((await start(t)).id);
    expect(run.status).toBe("failed");

    time.pass(DAYS + 1);
    expect((await t.workflows.pruneRunData()).runs).toBe(1);
    const after = await readRun(t, run.id);
    expect(after).toMatchObject({ status: "failed", error: run.error });
    expect(after.dataPrunedAt).toBeDefined();
    const failed = (await stepRunsOf(t, run.id)).filter((stepRun) => stepRun.status === "failed");
    expect(failed.map((stepRun) => stepRun.error?.code)).toEqual(["INTERNAL"]);
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
    for (let round = 0; round < 20; round++) {
      runs.push((await t.finish((await start(t)).id)).id);
    }
    time.pass(DAYS + 1);
    const [first, second] = await Promise.all([
      t.workflows.pruneRunData(),
      t.workflows.pruneRunData()
    ]);
    // Each step run was pruned by one of the two and each run marked by one.
    expect(first.stepRuns + second.stepRuns).toBe(20 * 7);
    expect(first.runs + second.runs).toBe(20);

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
    // The statement of one batch, twice at once on the same rows, 20 rounds: the first
    // round prunes, and every later one meets rows that are pruned already.
    const statement = () =>
      t.stores.workflowRuns.pruneStepRunData({ clientInstanceId, id: run.id, limit: 100 });
    for (let round = 0; round < 20; round++) {
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
