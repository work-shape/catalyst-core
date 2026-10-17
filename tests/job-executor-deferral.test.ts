import { JobDeferredError, defineJobHandler } from "@work-shape/catalyst-core";
import { describe, expect, it } from "vitest";
import { waitUntil } from "./support/assertions";
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
});
