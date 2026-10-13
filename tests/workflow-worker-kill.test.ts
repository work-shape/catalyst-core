import { afterEach, describe, expect, it } from "vitest";
import { waitUntil } from "./support/assertions";
import { stepRunsSchema } from "./support/workflow-instance";
import {
  ended,
  openProbeWorld,
  waitFor,
  writeProbeRecord,
  type ProbeWorld
} from "./support/workflow-probe-world";

// The kill probe of the Workflow engine: the server of an assembled instance runs the steps of
// a run in a process of its own and is ended with SIGKILL twice, once while a slow reading
// call is on its way and once while a changing call is. A new process is started each time.
//
// A killed process gives nothing back, so its step waits for the lease of its job, and a
// changing call it left without an outcome is waited for from its start. Both waits are ten
// minutes. In the suite the test first sees that nothing takes the step up, and then moves the
// two times in the database: the end of the lease to now, and the start of the call ten
// minutes back. The script of the probes (packages/workflows/scripts/probes.mjs) runs it with
// `WORKFLOW_PROBE_REAL_TIME=1`, which waits both out and keeps what it measured.
//
// What it holds today: a call that was cut off in flight is never made again, so the run
// ends as failed with `operation_interrupted` and a person checks what the call changed. The
// outside system is handed no idempotency key, so nothing could make the call again safely.

const REAL_TIME = process.env.WORKFLOW_PROBE_REAL_TIME === "1";
const MINUTE_MS = 60_000;
/** What one of the two waits may take: its ten minutes and the start of a process. */
const WAIT_MS = REAL_TIME ? 14 * MINUTE_MS : 2 * MINUTE_MS;
/** How long the probe watches a step that nobody takes up before it moves the time. */
const WATCHED_MS = 3_000;

const month = { ref: { step: "start", path: "input.month" } };
const WORKFLOW = {
  id: "kill-probe",
  name: "Kill probe",
  runAs: "workflow-runner",
  inputs: { type: "object", properties: { month: { type: "string" } }, required: ["month"] },
  outputs: { type: "object" },
  steps: [
    { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
    {
      id: "read",
      name: "Read slowly",
      type: "operation",
      operation: "connection.outside.slow_read",
      input: { month }
    },
    {
      id: "charge",
      name: "Charge",
      type: "operation",
      operation: "connection.outside.charge",
      input: { month }
    },
    {
      id: "confirm",
      name: "Read again",
      type: "operation",
      operation: "connection.outside.echo",
      input: { month }
    },
    { id: "result", name: "Result", type: "output", input: { month } }
  ]
};

describe("a Workflow Run whose worker process is killed", () => {
  let open: ProbeWorld | undefined;
  afterEach(async () => {
    await open?.close();
    open = undefined;
  });

  it(
    "is taken up by a new process, and its changing call takes effect once",
    async () => {
      const { world: t, worker: first } = await openProbeWorld();
      open = t;
      await t.publish(WORKFLOW);

      const stepJobs = () =>
        t.sql(
          (sql) => sql<{ status: string; attempts: number; leaseLeftSeconds: number | null }[]>`
            select status, attempts,
              extract(epoch from lease_expires_at - now())::float8 as "leaseLeftSeconds"
            from platform_jobs where kind like 'workflow%' and status in ('queued', 'running')`
        );
      /** Ends the wait for a job whose process is gone: its lease, or the time moved to it. */
      const afterTheLease = async (taken: () => boolean, what: string) => {
        const since = Date.now();
        if (!REAL_TIME) {
          await new Promise((resolve) => setTimeout(resolve, WATCHED_MS));
          expect(taken(), `${what} before the lease ended`).toBe(false);
          await t.sql(
            (sql) => sql`
              update platform_jobs set lease_expires_at = now()
              where kind like 'workflow%' and status = 'running'`
          );
        }
        await waitUntil(taken, what, WAIT_MS);
        return Date.now() - since;
      };

      // 1. Killed while the slow reading call is on its way.
      t.hold("slow_read");
      const run = await t.start(WORKFLOW.id, { month: "2026-10" });
      await waitUntil(() => t.arrivals("slow_read") === 1, "the slow call arrived", MINUTE_MS);
      await first.kill();
      t.release();
      const leftAfterFirstKill = await stepJobs();

      t.hold("charge");
      const second = await t.startWorker();
      const readAgainAfterMs = await afterTheLease(
        () => t.arrivals("charge") === 1,
        "the read was made again and the changing call arrived"
      );

      // 2. Killed while the changing call is in flight. The outside system has taken it.
      await second.kill();
      t.release();
      const leftAfterSecondKill = await stepJobs();

      await t.startWorker();
      const sinceThird = Date.now();
      if (!REAL_TIME) {
        await new Promise((resolve) => setTimeout(resolve, WATCHED_MS));
        expect(ended(await t.run(run.id)), "the run ended before the lease did").toBe(false);
        await t.sql(async (sql) => {
          await sql`
            update platform_jobs set lease_expires_at = now()
            where kind like 'workflow%' and status = 'running'`;
          await sql`
            update operation_runs
            set started_at = started_at - interval '10 minutes',
              created_at = created_at - interval '10 minutes'
            where status = 'running'`;
        });
      }
      await waitFor(async () => ended(await t.run(run.id)), "the run ended", 2 * WAIT_MS);
      const endedAfterMs = Date.now() - sinceThird;

      const after = await t.run(run.id);
      const stepRuns = stepRunsSchema.parse(
        (await t.api.call("workflows.list_step_runs", { params: { runId: run.id } })).json()
      ).items;
      const calls = await t.sql(
        (sql) => sql<{ operation: string; status: string; attempt: number }[]>`
          select operation, status, attempt from operation_runs order by created_at`
      );
      const record = {
        realTime: REAL_TIME,
        leftAfterFirstKill,
        readAgainAfterMs,
        leftAfterSecondKill,
        endedAfterMs,
        run: { status: after.status, error: after.error, stepRunCount: after.stepRunCount },
        stepRuns: stepRuns.map(({ key, status, attempt, error }) => ({
          key,
          status,
          attempt,
          error: error?.code
        })),
        calls,
        arrivals: {
          slow_read: t.arrivals("slow_read"),
          charge: t.arrivals("charge"),
          echo: t.arrivals("echo")
        }
      };
      if (REAL_TIME) await writeProbeRecord("kill", record);

      // A killed process keeps the lease of its step, close to the whole of it.
      for (const left of [leftAfterFirstKill, leftAfterSecondKill]) {
        expect(left).toHaveLength(1);
        expect(left[0]?.leaseLeftSeconds).toBeGreaterThan(9 * 60);
      }
      expect(after).toMatchObject({ status: "failed", error: { code: "operation_interrupted" } });
      expect(record.stepRuns).toEqual([
        { key: "start", status: "done", attempt: 1, error: undefined },
        { key: "read", status: "done", attempt: 2, error: undefined },
        { key: "charge", status: "failed", attempt: 2, error: "operation_interrupted" }
      ]);

      // The changing call took effect once, whatever the run ended as.
      expect(t.arrivals("charge")).toBe(1);
      // A reading call that had no answer is made again, and no step has two step runs.
      expect(t.arrivals("slow_read")).toBe(2);
      expect(new Set(stepRuns.map((stepRun) => stepRun.key)).size).toBe(stepRuns.length);
    },
    REAL_TIME ? 40 * MINUTE_MS : 5 * MINUTE_MS
  );
});
