import { afterEach, describe, expect, it } from "vitest";
import { connectionCallError } from "@work-shape/catalyst-core";
import { WORKFLOW_STEP_JOB_MAX_ATTEMPTS } from "@work-shape/catalyst-workflows";
import { operationOf } from "./support/connection-operations";
import { withTestSql } from "./support/test-sql";
import type { workflowFixture, WorkflowFixture } from "./support/workflow-instance";
import {
  answer,
  holdingFirst,
  reach,
  readyWorkflows,
  start,
  stepRunsOf,
  writesOf
} from "./support/workflow-runs";

// A changing call of a step whose operation names the header that carries its idempotency
// key to the outside system, which then carries out one call per key. Such a call is made
// again where it was cut off or failed for a reason that passes; what the outside system
// answers to the call that is made again decides how the step ends.

let open: WorkflowFixture | undefined;
/** Calls a test left hanging. They are let go when the test ends, so nothing outlives it. */
const hanging: (() => void)[] = [];
afterEach(async () => {
  for (const letGo of hanging.splice(0)) letGo();
  await open?.instance.close();
  open = undefined;
});

const ready = (options: Parameters<typeof workflowFixture>[0] = {}) =>
  readyWorkflows((fixture) => {
    open = fixture;
  }, options);

describe("a changing call that carries its key to the outside system", () => {
  // Fails without the change: the call that was cut off was never made again, whatever its
  // operation said, and the run ended as failed with `operation_interrupted`.
  it("makes the call again under the same key where the operation names the header that carries it, and the run finishes", async () => {
    const t = await ready({ limits: { operationOutcomeWaitMs: 400 } });
    await t.seed("crm", {
      operations: [
        operationOf("echo", { exposure: ["workflow"] }),
        operationOf("write", {
          effect: "changing",
          exposure: ["workflow"],
          idempotencyKeyHeader: "Idempotency-Key"
        })
      ]
    });
    const held = holdingFirst(t, "write", hanging);
    const started = await start(t);
    // The first worker is in the call when it dies: it never answers and never gives its
    // job back. Its lease is ended here, as time ends the lease of a process that is gone.
    await reach(t, held.inCall);
    await withTestSql(
      (sql) => sql`
        update platform_jobs set lease_expires_at = now() - interval '1 second'
        where kind = 'workflow_run.execute_step' and status = 'running'`
    );

    // The next worker finds the lease ended and queues the step again after the wait before a
    // second attempt, so it is given passes for as long as that takes.
    const worker = t.worker();
    let run = await t.finish(started.id, worker, 1).catch(() => undefined);
    for (const until = Date.now() + 30_000; !run && Date.now() < until;) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      run = await t.finish(started.id, worker, 1).catch(() => undefined);
    }
    if (!run) throw new Error("The run did not end");
    expect(run.error).toBeUndefined();
    expect(run.status).toBe("done");
    expect(JSON.parse(run.outputPreview?.text ?? "null")).toEqual({ sent: 3, failed: 0 });

    // The first client was sent to twice, under one key and the header the operation names.
    const first = t.executed.filter(
      (call) => call.operation === "write" && JSON.stringify(call.input).includes("client-anna")
    );
    expect(first).toHaveLength(2);
    expect(first[0]?.idempotencyKey).toMatchObject({ header: "Idempotency-Key" });
    expect(first[0]?.idempotencyKey?.value).toMatch(/^workflow_step:/u);
    expect(first[1]?.idempotencyKey).toEqual(first[0]?.idempotencyKey);
    // One Operation Run holds both attempts, and each other client was sent to once.
    const changing = (await t.runs()).filter(
      (call) => call.origin.kind === "workflow" && call.effect === "changing"
    );
    expect(changing.map((call) => [call.status, call.attempt]).sort()).toEqual([
      ["done", 1],
      ["done", 1],
      ["done", 2]
    ]);
    expect(writesOf(t)).toHaveLength(4);
  }, 60_000);

  /** `crm` with a `write` that names the header that carries its key outside. */
  const seedKeyed = (t: WorkflowFixture) =>
    t.seed("crm", {
      operations: [
        operationOf("echo", { exposure: ["workflow"] }),
        operationOf("write", {
          effect: "changing",
          exposure: ["workflow"],
          idempotencyKeyHeader: "Idempotency-Key"
        })
      ]
    });
  /** Gives a worker passes until the run has ended, the waits before further attempts among them. */
  async function finishInTime(t: WorkflowFixture, runId: string, worker = t.worker()) {
    for (const until = Date.now() + 40_000; Date.now() < until;) {
      const run = await t.finish(runId, worker, 1).catch(() => undefined);
      if (run) return run;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("The run did not end");
  }
  const expireLeases = () =>
    withTestSql(
      (sql) => sql`
        update platform_jobs set lease_expires_at = now() - interval '1 second'
        where kind = 'workflow_run.execute_step' and status = 'running'`
    );
  const firstWrite = async (t: WorkflowFixture) => {
    const [run] = (await t.runs()).filter(
      (call) => call.origin.kind === "workflow" && call.effect === "changing" && call.attempt > 1
    );
    return run;
  };

  // Fails without the change: the outcome of the process that was held up was written over
  // the run of the call that had taken it, which then read `failed` while its step was done.
  it("keeps the outcome of the call that took the run when the first process's outcome arrives late", async () => {
    const t = await ready({ limits: { operationOutcomeWaitMs: 400 } });
    await seedKeyed(t);
    // Two calls of the first client: the first is held and then fails, the second is held
    // and then answers. Every other call answers at once.
    const gates = [0, 1].map(() => {
      let open: () => void = () => undefined;
      let entered: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      const inCall = new Promise<void>((resolve) => {
        entered = resolve;
      });
      hanging.push(open);
      return { gate, inCall, open, entered };
    });
    let writes = 0;
    t.state.limits = { ...t.state.limits, callTimeoutMs: 30_000 };
    t.setBehaviour(async (operation, input) => {
      if (operation !== "write" || writes > 1) return answer(operation, input);
      const held = gates[writes];
      writes += 1;
      if (!held) return answer(operation, input);
      held.entered();
      await held.gate;
      if (held === gates[0]) throw connectionCallError("upstream_timeout");
      return answer(operation, input);
    });
    const [first, second] = gates;
    if (!first || !second) throw new Error("Two calls are held");

    const started = await start(t);
    const frozen = await reach(t, first.inCall);
    await expireLeases();
    // The second process takes the step up and its call is with the outside system.
    const next = t.worker();
    let there = false;
    const arrived = second.inCall.then(() => {
      there = true;
    });
    // A pass does not end while its call is held, so the passes are waited for at the end.
    const passes: Promise<unknown>[] = [];
    for (const until = Date.now() + 30_000; !there && Date.now() < until;) {
      passes.push(next.runDue().catch(() => undefined));
      await Promise.race([arrived, new Promise((resolve) => setTimeout(resolve, 200))]);
    }
    expect(there).toBe(true);

    // Now the first process wakes: its call ends as a failure, and it writes that.
    first.open();
    await frozen.stop();
    expect(await firstWrite(t)).toMatchObject({ status: "running", attempt: 2 });

    second.open();
    await Promise.all(passes);
    const run = await finishInTime(t, started.id, next);
    expect(run.error).toBeUndefined();
    expect(run.status).toBe("done");
    const kept = await firstWrite(t);
    expect(kept).toMatchObject({ status: "done", attempt: 2 });
    expect(kept?.error).toBeUndefined();
  }, 90_000);

  // Fails without the change: the first failed answer failed the step, whatever it was.
  it("makes a keyed call again that the outside system fails for now, three times at most, and then fails the step with the reason", async () => {
    const t = await ready();
    await seedKeyed(t);
    t.setBehaviour((operation, input) =>
      operation === "write"
        ? Promise.reject(connectionCallError("upstream_error"))
        : Promise.resolve(answer(operation, input))
    );
    const run = await finishInTime(t, (await start(t)).id);

    expect(run.status).toBe("failed");
    expect(run.error?.message).toBe("The operation 'connection.crm.write' failed (upstream_error)");
    const calls = t.executed.filter((call) => call.operation === "write");
    // One call per attempt of the step's job, each under the same key.
    expect(calls).toHaveLength(WORKFLOW_STEP_JOB_MAX_ATTEMPTS);
    expect(new Set(calls.map((call) => call.idempotencyKey?.value)).size).toBe(1);
    expect(
      (await stepRunsOf(t, run.id)).find((stepRun) => stepRun.key === "each_client[0].send")
    ).toMatchObject({ status: "failed", attempt: WORKFLOW_STEP_JOB_MAX_ATTEMPTS });
    expect(await firstWrite(t)).toMatchObject({
      status: "failed",
      attempt: WORKFLOW_STEP_JOB_MAX_ATTEMPTS,
      error: { reason: "upstream_error" }
    });
  }, 90_000);

  it("finishes where the outside system fails a keyed call once and then answers", async () => {
    const t = await ready();
    await seedKeyed(t);
    let failed = false;
    t.setBehaviour((operation, input) => {
      if (operation !== "write" || failed) return Promise.resolve(answer(operation, input));
      failed = true;
      return Promise.reject(connectionCallError("connection_unavailable"));
    });
    const run = await finishInTime(t, (await start(t)).id);
    expect(run.status).toBe("done");
    expect(JSON.parse(run.outputPreview?.text ?? "null")).toEqual({ sent: 3, failed: 0 });
    expect(writesOf(t)).toHaveLength(4);
  }, 90_000);

  // Fails without the change: a 409 was told as `upstream_error` like any failure.
  it("fails the step at once, with the conflict in its reason, where the outside system answers a repeated call with a conflict", async () => {
    const t = await ready({ limits: { operationOutcomeWaitMs: 400 } });
    await seedKeyed(t);
    const held = holdingFirst(t, "write", hanging);
    const started = await start(t);
    await reach(t, held.inCall);
    await expireLeases();
    // The call that is made again is answered 409 by the outside system.
    t.setBehaviour((operation, input) =>
      operation === "write"
        ? Promise.reject(connectionCallError("upstream_conflict"))
        : Promise.resolve(answer(operation, input))
    );

    const run = await finishInTime(t, started.id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatchObject({
      code: "CONFLICT",
      message: "The operation 'connection.crm.write' failed (upstream_conflict)"
    });
    // Once by the process that died and once again: a conflict is not tried a third time.
    expect(t.executed.filter((call) => call.operation === "write")).toHaveLength(2);
    expect(await firstWrite(t)).toMatchObject({
      status: "failed",
      attempt: 2,
      error: { reason: "upstream_conflict" }
    });
  }, 90_000);
});
