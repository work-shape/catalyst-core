import {
  JobLeaseLostError,
  defineJobHandler,
  defineJobKind,
  defineSchedule,
  scheduledJobPayloadSchema,
  type JobControl,
  type JobWorker
} from "@vivd-catalyst/core";
import { describe, expect, it } from "vitest";
import { deferred, waitUntil } from "./support/assertions";
import {
  advanceFakeClockUntilSettled,
  settleOnFakeClock,
  useFakeClockBesidePostgres
} from "./support/fake-clock";
import { kindOf, useJobExecutorHarness } from "./support/job-executor-harness";
import { usePostgresSuite } from "./support/postgres-suite";

describe("job executor leases, wake and start", () => {
  const db = usePostgresSuite("job_leases");
  const { worker, hang, jobs, onlyJob, expireLeases } = useJobExecutorHarness(db);

  it("neither renews nor commits through a lease that ran out, though no worker took the job", async () => {
    const clientInstanceId = db.clientInstance("expired");
    // A heartbeat every 300 ms.
    const kind = kindOf("test.expired", { leaseMs: 900 });
    const user = await db.store.users.createUser({ clientInstanceId, displayLabel: "Before" });
    const started = deferred<JobControl>();
    const only = worker(db.store, clientInstanceId, [
      defineJobHandler({
        kind,
        slots: 1,
        async run(_job, control) {
          started.resolve(control);
          await hang(control);
        }
      })
    ]);
    await db.store.jobs.enqueue(kind, { n: 1 }, { clientInstanceId });
    startPass(only);
    const control = await started.promise;
    const token = (await onlyJob(clientInstanceId)).lease_token;

    await expireLeases(clientInstanceId);

    await expect(
      control.transaction((stores) =>
        stores.users.updateUser({ clientInstanceId, userId: user.id, displayLabel: "After" })
      )
    ).rejects.toBeInstanceOf(JobLeaseLostError);
    // The next heartbeat finds the lease over and tells the handler, and does not revive it.
    await waitUntil(() => control.signal.aborted, "the handler is told that the lease is lost");
    const [lease] = await db.sql<{ expired: boolean; lease_token: string | null }[]>`
      select lease_expires_at < now() as expired, lease_token from platform_jobs
      where client_instance_id = ${clientInstanceId}`;
    expect(lease).toEqual({ expired: true, lease_token: token });
    const users = await db.store.users.listUsers({ clientInstanceId });
    expect(users.map((candidate) => candidate.displayLabel)).toEqual(["Before"]);
    expect(await onlyJob(clientInstanceId)).toMatchObject({ status: "running", attempts: 1 });
  });

  it("runs a job once when its transaction outlives the lease", async () => {
    const clientInstanceId = db.clientInstance("long_tx");
    const kind = kindOf("test.long_transaction", { leaseMs: 600 });
    const user = await db.store.users.createUser({ clientInstanceId, displayLabel: "Before" });
    const inTransaction = deferred<undefined>();
    const letGo = deferred<undefined>();
    let runs = 0;
    const handler = () =>
      defineJobHandler({
        kind,
        slots: 1,
        async run(_job, control) {
          runs += 1;
          await control.transaction(async (stores) => {
            inTransaction.resolve(undefined);
            await letGo.promise;
            await stores.users.updateUser({
              clientInstanceId,
              userId: user.id,
              displayLabel: "After"
            });
          });
        }
      });
    const first = worker(db.store, clientInstanceId, [handler()]);
    const second = worker(db.secondStore, clientInstanceId, [handler()]);
    await db.store.jobs.enqueue(kind, { n: 1 }, { clientInstanceId });

    startPass(first);
    await inTransaction.promise;
    // The transaction holds the row, so the attempt's own heartbeat waits and the lease runs
    // out. A waiting heartbeat computed its new expiry when it began to wait; a whole lease
    // later that expiry is in the past as well.
    await waitUntil(async () => {
      const [row] = await db.sql<{ expired: boolean }[]>`
        select lease_expires_at < now() - interval '700 milliseconds' as expired
        from platform_jobs where client_instance_id = ${clientInstanceId}`;
      return row?.expired === true;
    }, "the lease has run out during the transaction, a lease ago");
    // The second worker sees an expired lease and waits for the row to take the job over.
    startPass(second);
    await waitUntil(async () => {
      const [row] = await db.sql<{ waiting: number }[]>`
        select count(*)::int as waiting from pg_stat_activity
        where application_name = ${db.second} and wait_event_type = 'Lock'`;
      return (row?.waiting ?? 0) > 0;
    }, "the second worker waits for the job row");
    letGo.resolve(undefined);

    await waitUntil(
      async () => (await onlyJob(clientInstanceId)).status === "succeeded",
      "the job has succeeded"
    );
    await second.runDue();
    expect(runs).toBe(1);
    expect(await onlyJob(clientInstanceId)).toMatchObject({ status: "succeeded", attempts: 1 });
    const users = await db.store.users.listUsers({ clientInstanceId });
    expect(users.map((candidate) => candidate.displayLabel)).toEqual(["After"]);
  });

  it("claims a job enqueued in the same process without waiting for the next poll", async () => {
    const clientInstanceId = db.clientInstance("wake");
    const kind = kindOf("test.wake");
    const handled = [deferred<undefined>(), deferred<undefined>()];
    const started = worker(db.store, clientInstanceId, [
      defineJobHandler({
        kind,
        slots: 1,
        async run(job) {
          handled[job.payload.n]?.resolve(undefined);
        }
      })
    ]);
    // The poll sleeps on the fake clock, which this test keeps short of one poll interval.
    useFakeClockBesidePostgres();
    const startedAt = Date.now();
    started.start();

    for (const [n, done] of handled.entries()) {
      // The job is visible at commit; the worker hears of it then.
      await settleOnFakeClock(
        db.store.transaction((stores) => stores.jobs.enqueue(kind, { n }, { clientInstanceId }))
      );
      await advanceFakeClockUntilSettled(done.promise, 1, 300);
    }

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("makes the waiting tick of a schedule due when a worker starts, if the schedule says so", async () => {
    const clientInstanceId = db.clientInstance("due_at_start");
    const tick = (name: string) =>
      defineJobKind({
        kind: name,
        payloadSchema: scheduledJobPayloadSchema,
        maxAttempts: 1,
        backoff: { baseMs: 0, maxMs: 0 },
        leaseMs: 60_000,
        concurrency: { global: 1 }
      });
    const hour = 60 * 60 * 1000;
    const atStart = defineSchedule({ kind: tick("test.at_start"), every: hour, dueAtStart: true });
    const inTurn = defineSchedule({ kind: tick("test.in_turn"), every: hour });
    const ticks = { atStart: 0, inTurn: 0 };
    const process = () =>
      worker(
        db.store,
        clientInstanceId,
        [
          defineJobHandler({
            kind: atStart.kind,
            slots: 1,
            async run() {
              ticks.atStart += 1;
            }
          }),
          defineJobHandler({
            kind: inTurn.kind,
            slots: 1,
            async run() {
              ticks.inTurn += 1;
            }
          })
        ],
        [atStart, inTurn]
      );

    const before = process();
    await before.runDue();
    await before.runDue();
    expect(ticks).toEqual({ atStart: 1, inTurn: 1 });

    // The process restarts with both next ticks an hour away.
    await process().runDue();

    expect(ticks).toEqual({ atStart: 2, inTurn: 1 });
    const live = (await jobs(clientInstanceId)).filter((row) => row.status === "queued");
    expect(live).toHaveLength(2);
    expect(live.every((row) => !row.due)).toBe(true);
  });
});

/** Starts a pass whose handler blocks: the test reads the rows, not what the pass returns. */
function startPass(running: JobWorker): void {
  running.runDue().catch(() => undefined);
}
