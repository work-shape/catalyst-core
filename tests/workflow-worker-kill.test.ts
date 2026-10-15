import { afterEach, describe, expect, it } from "vitest";
import { waitUntil } from "./support/assertions";
import {
  WORKFLOW_STEP_JOB_HEARTBEAT_MS,
  WORKFLOW_STEP_JOB_LEASE_MS
} from "@work-shape/catalyst-workflows";
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
// A killed process gives nothing back, so its step waits for the lease of its job, which the
// process renewed every fifteen seconds while it lived and which ends ninety seconds after the
// last time. A changing call the process left without an outcome is waited for as long as its
// operation gives a call, from its start. In the suite the test first sees that nothing takes
// the step up, and then moves the two times in the database: the end of the lease to now, and
// the start of the call ten minutes back. The script of the probes
// (packages/workflows/scripts/probes.mjs) runs it with `WORKFLOW_PROBE_REAL_TIME=1`, which
// waits both out and keeps what it measured.
//
// The changing call names the header that carries its key to the outside system, which
// carries out one call per key. So the call that was cut off is made again under the same
// key, takes effect once, and the run finishes. The same call without the header is never
// made again: its run ends as failed with `operation_interrupted`.

const REAL_TIME = process.env.WORKFLOW_PROBE_REAL_TIME === "1";
const MINUTE_MS = 60_000;
/** What one of the waits may take: the lease, the time of a call and the start of a process. */
const WAIT_MS = REAL_TIME ? 5 * MINUTE_MS : 2 * MINUTE_MS;
/** The lease of a step's job, and how long its holder may take to renew it once. */
const LEASE_SECONDS = WORKFLOW_STEP_JOB_LEASE_MS / 1_000;
const RENEWED_WITHIN_MS = 2 * WORKFLOW_STEP_JOB_HEARTBEAT_MS;
/** How long the probe watches a step that nobody takes up before it moves the time. */
const WATCHED_MS = 3_000;

const month = { ref: { step: "start", path: "input.month" } };
const workflow = (id: string, changing: "charge" | "charge_unkeyed") => ({
  id,
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
      operation: `connection.outside.${changing}`,
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
});
const WORKFLOW = workflow("kill-probe", "charge");
const UNKEYED = workflow("kill-probe-unkeyed", "charge_unkeyed");

describe("a Workflow Run whose worker process is killed", () => {
  let open: ProbeWorld | undefined;
  afterEach(async () => {
    await open?.close();
    open = undefined;
  });

  /** The jobs of the engine that are queued or running, with what is left of their lease. */
  const stepJobs = (t: ProbeWorld) =>
    t.sql(
      (sql) => sql<
        { status: string; attempts: number; leaseLeftSeconds: number | null; beatAt: Date | null }[]
      >`
        select status, attempts, heartbeat_at as "beatAt",
          extract(epoch from lease_expires_at - now())::float8 as "leaseLeftSeconds"
        from platform_jobs where kind = 'workflow_run.execute_step' and status in ('queued', 'running')`
    );
  /** Ends the wait for a job whose process is gone: its lease, or the time moved to it. */
  async function afterTheLease(
    t: ProbeWorld,
    taken: () => boolean | Promise<boolean>,
    what: string,
    /** A changing call the dead process left is waited for from its start as well. */
    callInFlight = false
  ): Promise<number> {
    const since = Date.now();
    if (!REAL_TIME) {
      await new Promise((resolve) => setTimeout(resolve, WATCHED_MS));
      expect(await taken(), `${what} before the lease ended`).toBe(false);
      await t.sql(async (sql) => {
        await sql`
          update platform_jobs set lease_expires_at = now()
          where kind = 'workflow_run.execute_step' and status = 'running'`;
        if (!callInFlight) return;
        await sql`
          update operation_runs
          set started_at = started_at - interval '10 minutes',
            created_at = created_at - interval '10 minutes'
          where status = 'running'`;
      });
    }
    await waitFor(taken, what, WAIT_MS);
    return Date.now() - since;
  }
  const recordOf = async (t: ProbeWorld, runId: string) => {
    const run = await t.run(runId);
    const stepRuns = stepRunsSchema.parse(
      (await t.api.call("workflows.list_step_runs", { params: { runId } })).json()
    ).items;
    return {
      run: { status: run.status, error: run.error, stepRunCount: run.stepRunCount },
      stepRuns: stepRuns.map(({ key, status, attempt, error }) => ({
        key,
        status,
        attempt,
        error: error?.code
      })),
      calls: await t.sql(
        (sql) => sql<{ operation: string; status: string; attempt: number }[]>`
          select operation, status, attempt from operation_runs
          where origin_kind = 'workflow' order by created_at`
      )
    };
  };

  // Fails without the changes: a killed process kept its step for ten minutes, a living one
  // renewed its lease every 200 seconds, and the call that was cut off was never made again,
  // so the run ended as failed with `operation_interrupted`.
  it(
    "is taken up by a new process within a lease, makes its changing call again under the same key, and finishes",
    async () => {
      const { world: t, worker: first } = await openProbeWorld();
      open = t;
      await t.publish(WORKFLOW);

      // 1. Killed while the slow reading call is on its way.
      t.hold("slow_read");
      const run = await t.start(WORKFLOW.id, { month: "2026-10" });
      await waitUntil(() => t.arrivals("slow_read") === 1, "the slow call arrived", MINUTE_MS);
      // While the process lives it renews the lease of the step, however long the step takes.
      const [taken] = await stepJobs(t);
      await waitFor(
        async () => {
          const [now] = await stepJobs(t);
          return (now?.beatAt?.getTime() ?? 0) > (taken?.beatAt?.getTime() ?? 0);
        },
        "the living process renewed the lease of its step",
        RENEWED_WITHIN_MS
      );
      await first.kill();
      t.release();
      const leftAfterFirstKill = await stepJobs(t);

      t.hold("charge");
      const second = await t.startWorker();
      const readAgainAfterMs = await afterTheLease(
        t,
        () => t.arrivals("charge") === 1,
        "the read was made again and the changing call arrived"
      );

      // 2. Killed while the changing call is in flight. The outside system has taken it.
      await second.kill();
      t.release();
      const leftAfterSecondKill = await stepJobs(t);

      await t.startWorker();
      const endedAfterMs = await afterTheLease(
        t,
        async () => ended(await t.run(run.id)),
        "the run ended",
        true
      );

      const record = {
        realTime: REAL_TIME,
        leaseSeconds: LEASE_SECONDS,
        leftAfterFirstKill,
        readAgainAfterMs,
        leftAfterSecondKill,
        endedAfterMs,
        ...(await recordOf(t, run.id)),
        arrivals: {
          slow_read: t.arrivals("slow_read"),
          charge: t.arrivals("charge"),
          echo: t.arrivals("echo")
        },
        chargeKeys: new Set(t.keys("charge")).size
      };
      if (REAL_TIME) await writeProbeRecord("kill", record);

      // A killed process keeps its step for what is left of one lease and no longer.
      for (const left of [leftAfterFirstKill, leftAfterSecondKill]) {
        expect(left).toHaveLength(1);
        expect(left[0]?.leaseLeftSeconds).toBeLessThanOrEqual(LEASE_SECONDS);
      }
      if (REAL_TIME) {
        expect(readAgainAfterMs).toBeLessThan((LEASE_SECONDS + 30) * 1_000);
      }
      expect(record.run).toMatchObject({ status: "done", stepRunCount: 5 });
      expect(record.run.error).toBeUndefined();
      expect(record.stepRuns).toEqual([
        { key: "start", status: "done", attempt: 1, error: undefined },
        { key: "read", status: "done", attempt: 2, error: undefined },
        { key: "charge", status: "done", attempt: 2, error: undefined },
        { key: "confirm", status: "done", attempt: 1, error: undefined },
        { key: "result", status: "done", attempt: 1, error: undefined }
      ]);
      // The call was made twice under one key, which the outside system carries out once.
      const keys = t.keys("charge");
      expect(keys).toHaveLength(2);
      expect(keys[0]).toMatch(/^workflow_step:/u);
      expect(keys[1]).toBe(keys[0]);
      // A reading call that had no answer is made again, without a key.
      expect(t.keys("slow_read")).toEqual([undefined, undefined]);
      expect(t.arrivals("echo")).toBe(1);
    },
    REAL_TIME ? 20 * MINUTE_MS : 5 * MINUTE_MS
  );

  it(
    "never makes a changing call again that carries no key to the outside system, and says how to change that",
    async () => {
      const { world: t, worker: first } = await openProbeWorld();
      open = t;
      await t.publish(UNKEYED);

      t.hold("charge_unkeyed");
      const run = await t.start(UNKEYED.id, { month: "2026-10" });
      await waitUntil(() => t.arrivals("charge_unkeyed") === 1, "the call arrived", MINUTE_MS);
      await first.kill();
      t.release();

      await t.startWorker();
      await afterTheLease(t, async () => ended(await t.run(run.id)), "the run ended", true);

      const record = await recordOf(t, run.id);
      if (REAL_TIME) await writeProbeRecord("kill-unkeyed", record);
      expect(record.run).toMatchObject({
        status: "failed",
        error: { code: "operation_interrupted" }
      });
      expect(record.run.error?.message).toContain("may or may not have taken effect");
      expect(record.run.error?.message).toContain("idempotencyKeyHeader");
      expect(record.stepRuns.at(-1)).toEqual({
        key: "charge",
        status: "failed",
        attempt: 2,
        error: "operation_interrupted"
      });
      expect(t.keys("charge_unkeyed")).toEqual([undefined]);
    },
    REAL_TIME ? 20 * MINUTE_MS : 5 * MINUTE_MS
  );
});
