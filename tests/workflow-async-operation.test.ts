import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  WORKFLOW_ASSET_KIND,
  operationTimeoutKey,
  operationWakeKey,
  type JsonValue,
  type OperationDefinition,
  type OperationRunId,
  type OperationSource
} from "@work-shape/catalyst-core";
import { parseWorkflowManifest } from "@work-shape/catalyst-workflows";
import { clientInstanceId } from "./support/access-instance";
import { withTestSql } from "./support/test-sql";
import {
  hangingAt,
  publishedDefinitions,
  runSchema,
  type WorkflowFixture
} from "./support/workflow-instance";
import { notifyClients, readyWorkflows, start, stepRunsOf } from "./support/workflow-runs";

// An `operation` step on an operation whose work ends after the call (`completion: async`,
// EW-ASYNC), on Postgres and the engine's jobs: the step waits holding no slot, the end of
// the Operation Run wakes it in the transaction that ends the run, its `timeout` ends the wait
// while the work goes on, a cancel leaves the work going, and a retried step job finds the
// first call by the step run's idempotency key. The operation is a test one: the Knowledge
// Base's sync is SRC-1b. Acceptance checks 105 and 106 of the Events, Workflows And
// Guardrails spec, engine half.

const SYNC = "fixture_sync.start";
const STILL_RUNNING = "Abgleich läuft weiter";
const COUNTS = { added: 3, changed: 1, withdrawn: 0, failed: 0 };
const EXAMPLE = { added: 0, changed: 0, withdrawn: 0, failed: 0 };
const HOUR = 60 * 60 * 1_000;

const countsSchema = z.strictObject({
  added: z.number(),
  changed: z.number(),
  withdrawn: z.number(),
  failed: z.number()
});

/** What the test operation was asked and does: the runs it started, and its end at once. */
interface SyncState {
  started: OperationRunId[];
  /** Ends its own run with the counts before the call answers, as fast work does. */
  endAtOnce: boolean;
}

/** A sync that starts its work and answers; the test ends its Operation Run. */
function syncSource(t: WorkflowFixture, state: SyncState): OperationSource {
  const definition: OperationDefinition = {
    name: SYNC,
    effect: "changing",
    changeClass: "reversible",
    scope: null,
    auth: "principal",
    action: "connection.use",
    // The work may take days; the run of the call counts as interrupted only after that.
    timeoutMs: 72 * HOUR,
    completion: { mode: "async", stillRunning: STILL_RUNNING, example: EXAMPLE },
    inputSchema: z.object({ source: z.string() }),
    outputSchema: countsSchema,
    resource: () => undefined,
    async execute(_input, context) {
      state.started.push(context.runId);
      if (state.endAtOnce) {
        await t.stores.operationRuns.finish({
          clientInstanceId,
          id: context.runId,
          end: { status: "done", finishedAt: new Date().toISOString(), output: { value: COUNTS } }
        });
      }
      return { started: true };
    }
  };
  return {
    resolve: (name) => Promise.resolve(name === SYNC ? definition : undefined),
    list: () => Promise.resolve({ operations: [definition], truncated: [] })
  };
}

function syncWorkflow(id = "kb-sync", timeout?: string) {
  return {
    id,
    name: "Objektunterlagen abgleichen",
    runAs: "workflow-runner",
    inputs: { type: "object" },
    outputs: { type: "object" },
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
      {
        id: "sync",
        name: "Objekte abgleichen",
        type: "operation",
        operation: SYNC,
        input: { source: { value: "objekte" } },
        ...(timeout === undefined ? {} : { timeout })
      },
      {
        id: "counts",
        name: "Ergebnis",
        type: "output",
        input: {
          added: { ref: { step: "sync", path: "added" } },
          failed: { ref: { step: "sync", path: "failed" } }
        }
      }
    ]
  };
}

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});

/**
 * The instance with the test sync, and a clock the engine reads that a test can move. Its
 * Workflows are published ones, or with `assets` the saved assets of an instance.
 */
async function ready(options: { endAtOnce?: boolean; workflows?: unknown[]; assets?: true } = {}) {
  const clock = { offsetMs: 0 };
  const definitions = publishedDefinitions();
  for (const workflow of options.workflows ?? [syncWorkflow(), notifyClients()]) {
    definitions.publish(workflow);
  }
  const t = await readyWorkflows(
    (fixture) => {
      open = fixture;
    },
    {
      definitions: options.assets ? "assets" : definitions.source,
      now: () => new Date(Date.now() + clock.offsetMs)
    }
  );
  const state: SyncState = { started: [], endAtOnce: options.endAtOnce ?? false };
  t.operationCalls.registry.addSource(syncSource(t, state));
  t.state.centralSettings = [...t.state.centralSettings, { operation: SYNC, value: "allow" }];
  const startedRun = (n: number): OperationRunId => {
    const id = state.started[n];
    if (id === undefined) throw new Error(`The sync was not called ${n + 1} times`);
    return id;
  };
  /** The Operation Run a waiting step waits for: the run of its own call. */
  const runOf = (step: { operationRunId?: string } | undefined): OperationRunId => {
    const id = state.started.find((started) => started === step?.operationRunId);
    if (id === undefined) throw new Error("The step waits for no call of the sync");
    return id;
  };
  return { t, state, clock, startedRun, runOf };
}

async function startSync(t: WorkflowFixture, workflow = "kb-sync") {
  const response = await t.expectOk(t.root.id, "workflows.start", {
    params: { workflow },
    payload: { input: {} }
  });
  return runSchema.parse(response.json());
}

async function syncStep(t: WorkflowFixture, runId: string) {
  const [step] = (await stepRunsOf(t, runId)).filter((s) => s.stepId === "sync");
  return step;
}

/** Runs what is due until the run's sync step waits for its Operation Run. */
async function untilWaiting(t: WorkflowFixture, runIds: readonly string[], passes = 40) {
  const worker = t.worker();
  for (let pass = 0; pass < passes; pass++) {
    await worker.runDue();
    const steps = await Promise.all(runIds.map((id) => syncStep(t, id)));
    if (steps.every((step) => step?.status === "waiting")) return steps;
  }
  throw new Error("The sync steps did not wait");
}

const endSync = (
  t: WorkflowFixture,
  id: OperationRunId,
  end:
    | { status: "done"; output: JsonValue }
    | { status: "failed"; error: { code: string; message: string } }
) =>
  t.stores.operationRuns.finish({
    clientInstanceId,
    id,
    end:
      end.status === "done"
        ? { status: "done", finishedAt: new Date().toISOString(), output: { value: end.output } }
        : { status: "failed", finishedAt: new Date().toISOString(), error: end.error }
  });

const jobsOf = async (t: WorkflowFixture, subject: string | undefined) =>
  (
    await t.stores.jobs.listOverview({ clientInstanceId, filters: {}, page: { limit: 200 } })
  ).filter((job) => job.subject === subject);

const queuedKeysOf = (subject: string) =>
  withTestSql(async (sql) =>
    (
      await sql<{ dedupe_key: string; due: boolean }[]>`
        select dedupe_key, run_after <= now() as due from platform_jobs
        where subject = ${subject} and status = 'queued' order by dedupe_key`
    ).map((row) => ({ key: row.dedupe_key, due: row.due }))
  );

describe("an operation step on work that ends later", () => {
  // Acceptance check 105.
  it("waits holding no slot: four waiting syncs leave a fifth Workflow's steps running", async () => {
    const { t, state } = await ready();
    const runs = [];
    for (let n = 0; n < 4; n++) runs.push(await startSync(t));
    const waiting = await untilWaiting(
      t,
      runs.map((run) => run.id)
    );
    // Each step waits for the run of its own call; the jobs ran them in any order.
    expect(waiting.map((step) => step?.operationRunId).sort()).toEqual([...state.started].sort());
    for (const step of waiting) {
      // No job runs for a waiting step; only its timeout waits, six hours ahead.
      const jobs = await jobsOf(t, step?.id);
      expect(jobs.filter((job) => job.status === "running")).toEqual([]);
      expect(await queuedKeysOf(step?.id ?? "")).toEqual([
        { key: operationTimeoutKey(step?.id ?? ""), due: false }
      ]);
    }
    const fifth = await start(t);
    expect((await t.finish(fifth.id)).status).toBe("done");
    for (const run of runs) expect((await syncStep(t, run.id))?.status).toBe("waiting");
  });

  // Acceptance check 105.
  it("resumes once with the operation's result when its run ends done, after a restart", async () => {
    const { t, state, startedRun } = await ready();
    const started = await startSync(t);
    const [waiting] = await untilWaiting(t, [started.id]);
    await t.worker().stop();
    // The end of the run queues the step's job in its own transaction.
    expect(await endSync(t, startedRun(0), { status: "done", output: COUNTS })).toBeDefined();
    expect(await queuedKeysOf(waiting?.id ?? "")).toEqual([
      { key: operationWakeKey(waiting?.id ?? ""), due: true },
      { key: operationTimeoutKey(waiting?.id ?? ""), due: false }
    ]);
    const done = await t.finish(started.id, t.worker());
    expect(done.status, JSON.stringify(done.error)).toBe("done");
    expect(JSON.parse(done.outputPreview?.text ?? "null")).toEqual({ added: 3, failed: 0 });
    const steps = await stepRunsOf(t, started.id);
    expect(steps.filter((s) => s.stepId === "sync")).toEqual([
      expect.objectContaining({ status: "done", operationRunId: state.started[0] })
    ]);
    expect(steps.filter((s) => s.stepId === "counts")).toHaveLength(1);
    expect(state.started).toHaveLength(1);
    // The timeout was withdrawn with the wait, and nothing is left for the step.
    expect(await queuedKeysOf(waiting?.id ?? "")).toEqual([]);
    // A second end of the same run ends nothing and wakes nothing.
    expect(await endSync(t, startedRun(0), { status: "done", output: COUNTS })).toBe(undefined);
    expect(await queuedKeysOf(waiting?.id ?? "")).toEqual([]);
  });

  it("is answered at once when the work ended before the step began to wait", async () => {
    const { t, state } = await ready({ endAtOnce: true });
    const started = await startSync(t);
    const done = await t.finish(started.id);
    expect(done.status, JSON.stringify(done.error)).toBe("done");
    expect(JSON.parse(done.outputPreview?.text ?? "null")).toEqual({ added: 3, failed: 0 });
    expect(state.started).toHaveLength(1);
  });

  // Acceptance check 105.
  it("fails with the run's code when its run ends failed, and with output_invalid on a result that does not fit", async () => {
    const { t, runOf } = await ready();
    const failing = await startSync(t);
    const misfit = await startSync(t);
    const [failingStep, misfitStep] = await untilWaiting(t, [failing.id, misfit.id]);
    await endSync(t, runOf(failingStep), {
      status: "failed",
      error: { code: "knowledge_source_unreachable", message: "The source did not answer" }
    });
    await endSync(t, runOf(misfitStep), { status: "done", output: { added: "three" } });
    expect(await t.finish(failing.id)).toMatchObject({
      status: "failed",
      error: { code: "knowledge_source_unreachable" }
    });
    expect(await t.finish(misfit.id)).toMatchObject({
      status: "failed",
      error: { code: "output_invalid" }
    });
  });

  // Acceptance check 106.
  it("fails at its timeout with operation_still_running and the operation's sentence, and the work goes on", async () => {
    const { t, clock, startedRun } = await ready();
    // The step starts seven hours ago by the engine's clock; its wait is the default six.
    clock.offsetMs = -7 * HOUR;
    const started = await startSync(t);
    const [waiting] = await untilWaiting(t, [started.id]);
    expect(await queuedKeysOf(waiting?.id ?? "")).toEqual([
      { key: operationTimeoutKey(waiting?.id ?? ""), due: true }
    ]);
    clock.offsetMs = 0;
    const failed = await t.finish(started.id);
    expect(failed).toMatchObject({
      status: "failed",
      error: { code: "operation_still_running", message: STILL_RUNNING }
    });
    expect(await syncStep(t, started.id)).toMatchObject({
      status: "failed",
      error: { code: "operation_still_running", message: STILL_RUNNING }
    });
    const call = await t.stores.operationRuns.get({ clientInstanceId, id: startedRun(0) });
    expect(call?.status).toBe("running");
    // The work ends later, and nothing of the run moves.
    await endSync(t, startedRun(0), { status: "done", output: COUNTS });
    expect(await queuedKeysOf(waiting?.id ?? "")).toEqual([]);
  });

  it("waits no longer than its own timeout and not at all before it", async () => {
    const { t, clock } = await ready({ workflows: [syncWorkflow("kb-sync", "30m")] });
    clock.offsetMs = -20 * 60 * 1_000;
    const early = await startSync(t);
    await untilWaiting(t, [early.id]);
    clock.offsetMs = -45 * 60 * 1_000;
    const late = await startSync(t);
    await untilWaiting(t, [late.id]);
    clock.offsetMs = 0;
    const worker = t.worker();
    for (let pass = 0; pass < 5; pass++) await worker.runDue();
    expect((await syncStep(t, early.id))?.status).toBe("waiting");
    expect((await t.finish(late.id)).error?.code).toBe("operation_still_running");
  });

  // Acceptance check 106.
  it("ends the step cancelled on a cancel and leaves the work running", async () => {
    const { t, startedRun } = await ready();
    const started = await startSync(t);
    const [waiting] = await untilWaiting(t, [started.id]);
    const cancelled = runSchema.parse(
      (
        await t.expectOk(t.root.id, "workflows.cancel_run", { params: { runId: started.id } })
      ).json()
    );
    expect(cancelled.status).toBe("cancelled");
    expect(await syncStep(t, started.id)).toMatchObject({ status: "cancelled" });
    expect(await queuedKeysOf(waiting?.id ?? "")).toEqual([]);
    const call = await t.stores.operationRuns.get({ clientInstanceId, id: startedRun(0) });
    expect(call?.status).toBe("running");
    await endSync(t, startedRun(0), { status: "done", output: COUNTS });
    expect(await queuedKeysOf(waiting?.id ?? "")).toEqual([]);
  });

  // The lock order: the end of the Operation Run takes its own row and reads the steps; a
  // cancel takes the Workflow Run, then its step runs. Both at the same moment, many times.
  it("ends a run and a cancel at the same moment without a deadlock or a lost state", async () => {
    const { t, runOf } = await ready();
    const runs = [];
    for (let n = 0; n < 6; n++) runs.push(await startSync(t));
    const waiting = await untilWaiting(
      t,
      runs.map((run) => run.id)
    );
    await Promise.all(
      runs.flatMap((run, n) => [
        endSync(t, runOf(waiting[n]), { status: "done", output: COUNTS }),
        t.expectOk(t.root.id, "workflows.cancel_run", { params: { runId: run.id } })
      ])
    );
    const worker = t.worker();
    for (let pass = 0; pass < 5; pass++) await worker.runDue();
    for (const [n, run] of runs.entries()) {
      expect(
        runSchema.parse(
          (await t.call(t.root.id, "workflows.get_run", { params: { runId: run.id } })).json()
        ).status
      ).toBe("cancelled");
      expect((await syncStep(t, run.id))?.status).toBe("cancelled");
      expect(
        (await t.stores.operationRuns.get({ clientInstanceId, id: runOf(waiting[n]) }))?.status
      ).toBe("done");
      expect(await queuedKeysOf(waiting[n]?.id ?? "")).toEqual([]);
    }
  });

  // Acceptance check 106.
  it("finds the first call by the step run's key after its worker died, and starts no second sync", async () => {
    const { t, state, startedRun } = await ready();
    const started = await startSync(t);
    // The trigger takes two transactions; the sync's claim is the third, and its settle,
    // after the call started the work, the fourth: the worker dies there.
    const dying = hangingAt(t.workflows.jobHandlers, 4);
    const worker = t.worker(dying.handlers);
    let reached = false;
    const arrived = dying.reached.then(() => {
      reached = true;
    });
    for (let pass = 0; pass < 20 && !reached; pass++)
      await Promise.race([worker.runDue(), arrived]);
    expect(reached).toBe(true);
    expect(state.started).toHaveLength(1);
    await worker.stop();
    const [waiting] = await untilWaiting(t, [started.id], 200);
    expect(waiting).toMatchObject({ status: "waiting", operationRunId: state.started[0] });
    expect(state.started).toHaveLength(1);
    await endSync(t, startedRun(0), { status: "done", output: COUNTS });
    expect((await t.finish(started.id)).status).toBe("done");
    expect(state.started).toHaveLength(1);
  });

  it("still ends at its timeout when the worker died between taking the timeout up and ending the step", async () => {
    const { t, state, clock, startedRun } = await ready({
      workflows: [syncWorkflow("kb-sync", "30m")]
    });
    clock.offsetMs = -45 * 60 * 1_000;
    const started = await startSync(t);
    await untilWaiting(t, [started.id]);
    clock.offsetMs = 0;
    // The timeout job's claim is its first transaction and its settle the second: the
    // worker dies there, with the step taken up and not ended.
    const dying = hangingAt(t.workflows.jobHandlers, 2);
    const worker = t.worker(dying.handlers);
    let reached = false;
    const arrived = dying.reached.then(() => {
      reached = true;
    });
    for (let pass = 0; pass < 20 && !reached; pass++)
      await Promise.race([worker.runDue(), arrived]);
    expect(reached).toBe(true);
    expect((await syncStep(t, started.id))?.status).toBe("running");
    await worker.stop();
    const failed = await t.finish(started.id);
    expect(failed).toMatchObject({
      status: "failed",
      error: { code: "operation_still_running", message: STILL_RUNNING }
    });
    // A result after the timeout moves nothing, and no second sync was started.
    await endSync(t, startedRun(0), { status: "done", output: COUNTS });
    expect(await syncStep(t, started.id)).toMatchObject({
      status: "failed",
      error: { code: "operation_still_running" }
    });
    expect(state.started).toHaveLength(1);
  });
});

describe("the timeout of an operation step", () => {
  // Waiting counts toward no limit of the run, so the time an operation may take is bounded
  // only by its own timeout, not by the run time.
  it("reads minutes, hours and days, beyond the run time, and refuses anything else", () => {
    const parsed = (timeout: string) => parseWorkflowManifest(syncWorkflow("kb-sync", timeout)).ok;
    expect(parsed("30m")).toBe(true);
    expect(parsed("6h")).toBe(true);
    expect(parsed("13h")).toBe(true);
    expect(parsed("721m")).toBe(true);
    expect(parsed("3d")).toBe(true);
    expect(parsed("0h")).toBe(false);
    expect(parsed("6 hours")).toBe(false);
    expect(parsed("2w")).toBe(false);
  });
});

describe("a test run of a draft with work that ends later", () => {
  it("simulates the changing call and gives the operation's example as the step's output", async () => {
    const { t, state } = await ready({ assets: true });
    await t.allow({ kind: "user", id: t.kai.id }, "connection.use");
    await t.allow({ kind: "user", id: t.kai.id }, "workflow.write");
    await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: WORKFLOW_ASSET_KIND, name: "kb-draft" },
      payload: {
        config: { name: "kb-draft", manifest: syncWorkflow("kb-draft") },
        expectedRevision: null
      }
    });
    const response = await t.call(t.kai.id, "workflows.test", {
      params: { workflow: "kb-draft" },
      payload: { input: {} }
    });
    expect(response.json()).not.toHaveProperty("error");
    const run = runSchema.parse(response.json());
    const ended = await t.finish(run.id);
    expect(ended.status, JSON.stringify(ended.error)).toBe("done");
    expect(JSON.parse(ended.outputPreview?.text ?? "null")).toEqual({ added: 0, failed: 0 });
    expect(await syncStep(t, run.id)).toMatchObject({ status: "done", target: "dry_run" });
    expect(state.started).toEqual([]);
  });
});
