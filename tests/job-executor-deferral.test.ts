import { JobDeferredError, defineJobHandler } from "@work-shape/catalyst-core";
import { describe, expect, it } from "vitest";
import { deferred, waitUntil } from "./support/assertions";
import { kindOf, useJobExecutorHarness } from "./support/job-executor-harness";
import { usePostgresSuite } from "./support/postgres-suite";

describe("source-requested job deferral", () => {
  const db = usePostgresSuite("job_deferral");
  const { worker, onlyJob } = useJobExecutorHarness(db);
  it("defers until the source's time, without spending an attempt or keeping a slot", async () => {
    const clientInstanceId = db.clientInstance("deferred");
    const kind = kindOf("test.deferred", { maxAttempts: 1 });
    let calls = 0;
    const only = worker(db.store, clientInstanceId, [
      defineJobHandler({
        kind,
        slots: 1,
        async run() {
          calls += 1;
          if (calls === 1) throw new JobDeferredError(2_000);
        }
      })
    ]);
    await db.store.jobs.enqueue(kind, { n: 1 }, { clientInstanceId });
    const before = Date.now();
    await only.runDue();
    expect(await onlyJob(clientInstanceId)).toMatchObject({ status: "queued", attempts: 0 });
    const queued = await onlyJob(clientInstanceId);
    expect(queued.run_after.getTime() - before).toBeGreaterThanOrEqual(2_000);
    await only.runDue();
    expect(calls).toBe(1);
    await waitUntil(async () => {
      await only.runDue();
      return (await onlyJob(clientInstanceId)).status === "succeeded";
    }, "the deferred job succeeds");
    expect(calls).toBe(2);
    expect(await onlyJob(clientInstanceId)).toMatchObject({ status: "succeeded", attempts: 1 });
  });
  it("queues one deadline wake requested while its own row is running", async () => {
    const clientInstanceId = db.clientInstance("deadline_wake");
    const kind = kindOf("workflow_run.deadline");
    const entered = deferred<void>();
    const release = deferred<void>();
    let calls = 0;
    const handlers = [
      defineJobHandler({
        kind,
        slots: 1,
        async run(_job, control) {
          calls++;
          if (calls === 1)
            await control.transaction(async () => {
              entered.resolve();
              await release.promise;
            });
        }
      })
    ];
    const first = worker(db.store, clientInstanceId, handlers);
    const second = worker(db.secondStore, clientInstanceId, handlers);
    const options = { clientInstanceId, dedupeKey: "deadline", runAfter: new Date() };
    await db.store.jobs.enqueue(kind, { n: 1 }, options);
    const running = first.runDue();
    try {
      await entered.promise;
      // A separate transaction can request this without waiting on the leased job row.
      await db.secondStore.jobs.runAgainAfter(kind, { n: 1 }, options);
      await db.secondStore.jobs.runAgainAfter(kind, { n: 1 }, options);
      await second.runDue();
      expect(calls).toBe(1);
    } finally {
      release.resolve();
      await running;
    }
    await second.runDue();
    await first.runDue();
    expect(calls).toBe(2);
    const rows =
      await db.sql`select status from platform_jobs where client_instance_id = ${clientInstanceId}`;
    expect(rows.map((row) => row.status)).toEqual(["succeeded", "succeeded"]);
    expect(
      await db.sql`select 1 from platform_job_wakes where client_instance_id = ${clientInstanceId}`
    ).toHaveLength(0);
  }, 120_000);
});
