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
import { deferred, required, waitUntil } from "./support/assertions";
import { kindOf, useJobExecutorHarness } from "./support/job-executor-harness";
import { usePostgresSuite } from "./support/postgres-suite";
import { withTestSql } from "./support/test-sql";

describe("job executor leases, wake and start", () => {
  const db = usePostgresSuite("job_leases");
  const { worker, hang, jobs, onlyJob, expireLeases, heartbeatsByHand } = useJobExecutorHarness(db);

  it("neither renews nor commits through a lease that ran out, though no worker took the job", async () => {
    const clientInstanceId = db.clientInstance("expired");
    const kind = kindOf("test.expired");
    const beat = heartbeatsByHand();
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
    expect(control.signal.aborted).toBe(false);
    beat();
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
    // The lease the transaction leaves behind is long, so the attempt ends under it on any
    // machine. The lease that runs out is the one the test shortens below.
    const kind = kindOf("test.long_transaction");
    heartbeatsByHand();
    const user = await db.store.users.createUser({ clientInstanceId, displayLabel: "Before" });
    const started = deferred<undefined>();
    const enter = deferred<undefined>();
    const inTransaction = deferred<undefined>();
    const letGo = deferred<undefined>();
    let runs = 0;
    const handler = () =>
      defineJobHandler({
        kind,
        slots: 1,
        async run(_job, control) {
          runs += 1;
          started.resolve(undefined);
          await enter.promise;
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
    const waitingForARow = async (applicationName: string) => {
      const [row] = await db.sql<{ waiting: number }[]>`
        select count(*)::int as waiting from pg_stat_activity
        where application_name = ${applicationName} and wait_event_type = 'Lock'`;
      return (row?.waiting ?? 0) > 0;
    };

    startPass(first);
    await started.promise;
    // The transaction must take the row under a live lease, and the lease must be over while
    // it holds the row. So the lease gets one more second in the statement that hands the row
    // to the waiting transaction: between the two lies no round trip of this process, only
    // the database passing a lock on.
    const gate = 706_002;
    const held = await db.hold((tx) => tx`select pg_advisory_xact_lock(${gate})`);
    await withTestSql(async (sql) => {
      // The driver sends a query when it is awaited or executed; this one must be on its way.
      const shortened = sql
        .unsafe(
          `
        begin;
        select id from platform_jobs where client_instance_id = '${clientInstanceId}' for update;
        select pg_advisory_xact_lock(${gate});
        update platform_jobs set lease_expires_at = clock_timestamp() + interval '1 second'
          where client_instance_id = '${clientInstanceId}';
        commit;
      `
        )
        .execute();
      await waitUntil(async () => {
        const [row] = await db.sql<{ waiting: number }[]>`
          select count(*)::int as waiting from pg_locks
          where locktype = 'advisory' and objid = ${gate} and not granted`;
        return row?.waiting === 1;
      }, "the job row is held for the shortened lease");
      enter.resolve(undefined);
      await waitUntil(() => waitingForARow(db.first), "the transaction waits for the job row");
      await held.rollback();
      await shortened;
    });
    await inTransaction.promise;

    // No heartbeat begins in this test. One that waited for the row since the lease was live
    // would renew it when the transaction lets go, and hide a transaction that does not.
    await waitUntil(async () => {
      const [row] = await db.sql<{ expired: boolean }[]>`
        select lease_expires_at < now() as expired
        from platform_jobs where client_instance_id = ${clientInstanceId}`;
      return row?.expired === true;
    }, "the lease has run out during the transaction");
    // The second worker sees an expired lease and waits for the row to take the job over.
    startPass(second);
    await waitUntil(() => waitingForARow(db.second), "the second worker waits for the job row");
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

  it("writes the handler's copy of the lease in the heartbeat's own transaction", async () => {
    const clientInstanceId = db.clientInstance("mirror");
    const kind = kindOf("test.mirror");
    const beat = heartbeatsByHand();
    const user = await db.store.users.createUser({ clientInstanceId, displayLabel: "none" });
    const started = deferred<JobControl>();
    let failing = false;
    let failed = 0;
    const only = worker(db.store, clientInstanceId, [
      defineJobHandler({
        kind,
        slots: 1,
        async run(_job, control) {
          started.resolve(control);
          await hang(control);
        },
        async onHeartbeat(_job, lease, stores) {
          await stores.users.updateUser({
            clientInstanceId,
            userId: user.id,
            displayLabel: lease.leaseToken
          });
          if (!failing) return;
          failed += 1;
          throw new Error("the copy cannot be written");
        }
      })
    ]);
    await db.store.jobs.enqueue(kind, { n: 1 }, { clientInstanceId });
    startPass(only);
    const control = await started.promise;
    const label = async () =>
      (await db.store.users.listUsers({ clientInstanceId })).map((found) => found.displayLabel);

    /**
     * The lease's end as committed. The read locks the job row, which a heartbeat under way
     * holds to the end of its transaction, so it answers only after that heartbeat is over.
     */
    const expiry = async () =>
      (
        await db.sql<{ lease_expires_at: Date }[]>`
          select lease_expires_at from platform_jobs
          where client_instance_id = ${clientInstanceId} for update`
      )[0]?.lease_expires_at.getTime();
    const claimed = required(await expiry());

    beat();
    await waitUntil(
      async () => (await label())[0] === control.leaseToken,
      "the heartbeat hands the lease token to the handler"
    );
    // The same transaction renewed the lease.
    const renewed = required(await expiry());
    expect(renewed).toBeGreaterThan(claimed);

    // A copy that cannot be written takes the heartbeat with it: the job's lease is not
    // extended past what its subject shows.
    failing = true;
    await db.store.users.updateUser({ clientInstanceId, userId: user.id, displayLabel: "none" });
    beat();
    await waitUntil(() => failed === 1, "a heartbeat tries to write the copy and fails");
    expect(await expiry()).toBe(renewed);
    expect(await label()).toEqual(["none"]);
  });

  it("claims a job enqueued in the same process without waiting for the next poll", async () => {
    const clientInstanceId = db.clientInstance("wake");
    const kind = kindOf("test.wake");
    const started = worker(db.store, clientInstanceId, [
      defineJobHandler({ kind, slots: 1, async run() {} })
    ]);
    started.start();
    await started.idle();

    for (const n of [0, 1]) {
      // The job is visible at commit; the worker hears of it then, and is idle again only
      // after the pass that the enqueue asked for. A worker that waited for its poll would be
      // idle at once, with the job still queued.
      await db.store.transaction((stores) =>
        stores.jobs.enqueue(kind, { n }, { clientInstanceId })
      );
      await started.idle();
      expect((await jobs(clientInstanceId)).map((job) => job.status)).toEqual(
        Array.from({ length: n + 1 }, () => "succeeded")
      );
    }
  });

  it("claims a job enqueued while a slow claim is under way, without waiting for the next poll", async () => {
    const clientInstanceId = db.clientInstance("wake_slow");
    const slow = kindOf("test.wake_slow");
    const late = kindOf("test.wake_late");
    const started = worker(db.store, clientInstanceId, [
      defineJobHandler({ kind: slow, slots: 1, async run() {} }),
      defineJobHandler({ kind: late, slots: 1, async run() {} })
    ]);
    // The claim of a `slow` job waits inside its UPDATE for a lock this test holds.
    const gate = 706_001;
    await db.sql.unsafe(`
      create function hold_slow_claim() returns trigger language plpgsql as $$
      begin
        perform pg_advisory_xact_lock(${gate});
        return new;
      end $$;
      create trigger hold_slow_claim before update on platform_jobs for each row
        when (new.kind = 'test.wake_slow' and new.status = 'running' and old.status = 'queued')
        execute function hold_slow_claim();
    `);
    let release = async () => {};
    try {
      started.start();
      await started.idle();
      const held = await db.hold((tx) => tx`select pg_advisory_xact_lock(${gate})`);
      release = async () => {
        release = async () => {};
        await held.rollback();
      };

      await db.store.jobs.enqueue(slow, { n: 0 }, { clientInstanceId });
      await waitUntil(async () => {
        const [row] = await db.sql<{ waiting: number }[]>`
          select count(*)::int as waiting from pg_locks
          where locktype = 'advisory' and objid = ${gate} and not granted`;
        return row?.waiting === 1;
      }, "the claim waits for the lock");
      // The pass under way looked for kinds with work before this job existed.
      await db.store.jobs.enqueue(late, { n: 1 }, { clientInstanceId });
      await release();

      await started.idle();
      expect((await jobs(clientInstanceId)).map((job) => job.status)).toEqual([
        "succeeded",
        "succeeded"
      ]);
    } finally {
      // A claim still waiting for the lock would keep the trigger from being dropped.
      await release();
      await db.sql.unsafe(`
        drop trigger hold_slow_claim on platform_jobs;
        drop function hold_slow_claim();
      `);
    }
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
