import { setTimeout } from "node:timers/promises";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { fixture } from "./support/operation-approval";
import { fileTestDatabaseUrl } from "./support/test-database";
import { withTestSql } from "./support/test-sql";

// The outcome of an approved call is written on its request after the call ran. Another
// transaction can hold the request at that moment, such as a second click on Allow that is
// being refused. Before the fix the write gave up at once: the call was done, and its request
// said "queued" for good.

/**
 * Holds the request's row in a transaction of its own until `release` resolves, as a second
 * decision does while it is refused.
 */
async function holdRequest(requestId: string, release: Promise<unknown>) {
  const sql = postgres(await fileTestDatabaseUrl(), { max: 1 });
  let held!: () => void;
  const holding = new Promise<void>((resolve) => (held = resolve));
  const done = sql
    .begin(async (tx) => {
      await tx`select id from approval_requests where id = ${requestId} for update`;
      held();
      await release;
    })
    .finally(() => sql.end());
  await holding;
  return done;
}

describe("the outcome of an approved call while its request is held", () => {
  it("is recorded once the request is free again: the request ends done", async () => {
    const f = await fixture();
    const { runId, requestId } = await f.hold("held-briefly");
    expect((await f.decide("approver", requestId, "approve")).statusCode).toBe(200);

    // Held from before the call runs until shortly after it ran.
    let ran!: () => void;
    const released = holdRequest(
      requestId,
      new Promise<void>((resolve) => (ran = resolve)).then(() => setTimeout(200))
    );
    const jobs = f.runJobs();
    await expect.poll(() => f.executed, { timeout: 30_000 }).toEqual(["requester:held-briefly"]);
    ran();
    await released;
    await jobs;

    expect(await f.run(runId)).toMatchObject({ status: "done" });
    const request = await f.stored(requestId);
    expect(request).toMatchObject({
      status: "approved",
      applyResult: { runId, execution: "done" }
    });
    expect(request.payload).not.toHaveProperty("input");
  }, 60_000);

  it("is recorded from the run by the upkeep job where the request stayed held", async () => {
    const f = await fixture();
    const { runId, requestId } = await f.hold("held-long");
    expect((await f.decide("approver", requestId, "approve")).statusCode).toBe(200);

    // Held for longer than the write tries again.
    let free!: () => void;
    const released = holdRequest(requestId, new Promise<void>((resolve) => (free = resolve)));
    await f.runJobs();
    expect(f.executed).toEqual(["requester:held-long"]);
    expect(await f.run(runId)).toMatchObject({ status: "done" });
    expect(await f.stored(requestId)).toMatchObject({ applyResult: { execution: "queued" } });
    free();
    await released;

    // The upkeep pass is due now instead of in six hours.
    await withTestSql(
      (sql) => sql`
        update platform_jobs set run_after = now()
        where kind = 'operation_call.remove_ended_input' and status = 'queued'`
    );
    await f.runJobs();
    const request = await f.stored(requestId);
    expect(request).toMatchObject({
      status: "approved",
      applyResult: { runId, execution: "done" }
    });
    expect(request.payload).not.toHaveProperty("input");
  }, 60_000);
});
