import {
  JOB_WORKER_REPORT_INTERVAL_MS,
  JOB_WORKER_SILENT_MS,
  JobWithdrawnError,
  defineJobHandler
} from "@vivd-catalyst/core";
import { describe, expect, it } from "vitest";
import { required } from "./support/assertions";
import { kindOf, useJobExecutorHarness } from "./support/job-executor-harness";
import { usePostgresSuite } from "./support/postgres-suite";

// What the instance knows of its workers beside the jobs they end: which kinds a worker claims
// and since when, and that a job somebody gave up is not a job that succeeded.

describe("job workers report the kinds they claim", () => {
  const db = usePostgresSuite("job_worker_reports");
  const { worker, onlyJob } = useJobExecutorHarness(db);

  it("reports a kind with every pass that is due, and starts a new time of being up after a silence", async () => {
    const clientInstanceId = db.clientInstance("reports");
    const served = kindOf("test.served");
    const unserved = kindOf("test.unserved");
    // The process has a handler for one of the two kinds.
    const handlers = () => [defineJobHandler({ kind: served, slots: 1, async run() {} })];
    const report = (kind: string) => db.store.jobs.readWorkerReport({ clientInstanceId, kind });
    expect(await report(served.kind)).toBeUndefined();

    // No job is queued: that the worker asks for work is the report.
    await worker(db.store, clientInstanceId, handlers()).runDue();

    const first = required(await report(served.kind));
    expect(first).toEqual({ kind: served.kind, aliveSince: first.seenAt, seenAt: first.seenAt });
    expect(await report(unserved.kind)).toBeUndefined();

    // 13 seconds later, past the report interval and within the silent time: the same worker time.
    expect(13_000).toBeGreaterThan(JOB_WORKER_REPORT_INTERVAL_MS);
    expect(13_000).toBeLessThan(JOB_WORKER_SILENT_MS);
    await db.sql`
      update job_worker_reports
      set seen_at = seen_at - interval '13 seconds', alive_since = alive_since - interval '13 seconds'
      where client_instance_id = ${clientInstanceId}`;
    const moved = required(await report(served.kind));
    await worker(db.store, clientInstanceId, handlers()).runDue();
    const second = required(await report(served.kind));
    expect(second.aliveSince).toBe(moved.aliveSince);
    expect(Date.parse(second.seenAt)).toBeGreaterThan(Date.parse(moved.seenAt));

    // 47 seconds without a report: the worker that reports next is a worker that came back.
    await db.sql`
      update job_worker_reports
      set seen_at = seen_at - interval '47 seconds', alive_since = alive_since - interval '47 seconds'
      where client_instance_id = ${clientInstanceId}`;
    await worker(db.store, clientInstanceId, handlers()).runDue();
    const third = required(await report(served.kind));
    expect(third.aliveSince).toBe(third.seenAt);
  });

  it("ends a job whose handler finds its subject withdrawn as cancelled, without another attempt", async () => {
    const clientInstanceId = db.clientInstance("withdrawn");
    const kind = kindOf("test.withdrawn");
    let runs = 0;
    const handler = defineJobHandler({
      kind,
      slots: 1,
      async run() {
        runs += 1;
        throw new JobWithdrawnError("The subject was given up");
      }
    });
    await db.store.jobs.enqueue(kind, { n: 1 }, { clientInstanceId });
    const serving = worker(db.store, clientInstanceId, [handler]);

    await serving.runDue();
    await serving.runDue();

    expect(runs).toBe(1);
    // The kind allows three attempts: this is neither a failure to retry nor a success.
    expect(await onlyJob(clientInstanceId)).toMatchObject({
      status: "cancelled",
      attempts: 1,
      error_code: "WITHDRAWN"
    });
  });
});
