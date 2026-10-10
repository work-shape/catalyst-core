import {
  JobLeaseLostError,
  NonRetryableJobError,
  defineJobHandler,
  defineJobKind,
  defineSchedule,
  scheduledJobPayloadSchema,
  type Job,
  type JobControl,
  type JobHandler,
  type JobWorker,
  type RegisteredJobHandler
} from "@vivd-catalyst/core";
import { describe, expect, it, vi } from "vitest";
import { deferred, required, waitUntil } from "./support/assertions";
import { advanceFakeClockUntilSettled, useFakeClockBesidePostgres } from "./support/fake-clock";
import { kindOf, useJobExecutorHarness, type Numbered } from "./support/job-executor-harness";
import { usePostgresSuite } from "./support/postgres-suite";
import { createTestInstance } from "./support/test-instance";

describe("job executor", () => {
  const db = usePostgresSuite("jobs");
  const { worker, hang, jobs, onlyJob, expireLeases } = useJobExecutorHarness(db);

  it("never runs one job on two workers, with the claim raced in a loop", async () => {
    const clientInstanceId = db.clientInstance("race");
    const kind = kindOf("test.race");
    const runs = new Map<number, number>();
    const handler = (): RegisteredJobHandler =>
      defineJobHandler({
        kind,
        slots: 3,
        async run(job) {
          runs.set(job.payload.n, (runs.get(job.payload.n) ?? 0) + 1);
        }
      });
    const first = worker(db.store, clientInstanceId, [handler()]);
    const second = worker(db.secondStore, clientInstanceId, [handler()]);
    for (let n = 0; n < 60; n += 1) await db.store.jobs.enqueue(kind, { n }, { clientInstanceId });

    await waitUntil(async () => {
      await Promise.all([first.runDue(), second.runDue()]);
      return (await jobs(clientInstanceId)).every((job) => job.status === "succeeded");
    }, "every raced job has succeeded");

    expect(runs.size).toBe(60);
    expect([...runs.values()].every((count) => count === 1)).toBe(true);
    expect((await jobs(clientInstanceId)).every((job) => job.attempts === 1)).toBe(true);
  });

  it.each([
    { name: "global: 1", concurrency: { global: 1 }, limitPerKey: false },
    { name: "perKey: 1", concurrency: { perKey: 1 }, limitPerKey: true }
  ])("never exceeds $name across two workers", async ({ concurrency, limitPerKey }) => {
    const clientInstanceId = db.clientInstance(limitPerKey ? "per_key" : "global");
    const kind = kindOf(limitPerKey ? "test.per_key" : "test.global", { concurrency });
    const running = new Map<string, number>();
    let highest = 0;
    let finished = 0;
    const handler = (): RegisteredJobHandler =>
      defineJobHandler({
        kind,
        slots: 4,
        async run(job) {
          const key = limitPerKey ? required(job.concurrencyKey) : "all";
          const now = (running.get(key) ?? 0) + 1;
          running.set(key, now);
          highest = Math.max(highest, now);
          // A round trip to the database, so that the other worker polls while this one runs.
          await db.store.audit.listAuditEvents({ clientInstanceId, limit: 1 });
          running.set(key, now - 1);
          finished += 1;
        }
      });
    const first = worker(db.store, clientInstanceId, [handler()]);
    const second = worker(db.secondStore, clientInstanceId, [handler()]);
    for (let n = 0; n < 30; n += 1)
      await db.store.jobs.enqueue(
        kind,
        { n },
        { clientInstanceId, concurrencyKey: `key-${n % 3}` }
      );

    await waitUntil(async () => {
      await Promise.all([first.runDue(), second.runDue()]);
      return finished === 30;
    }, "every limited job has run");

    expect(highest).toBe(1);
  });

  it("runs several keys at once under perKey: 1", async () => {
    const clientInstanceId = db.clientInstance("keys");
    const kind = kindOf("test.keys", { concurrency: { perKey: 1 } });
    const started: string[] = [];
    const only = worker(db.store, clientInstanceId, [
      defineJobHandler({
        kind,
        slots: 4,
        async run(job, control) {
          started.push(required(job.concurrencyKey));
          await hang(control);
        }
      })
    ]);
    for (const key of ["a", "a", "b", "c"])
      await db.store.jobs.enqueue(kind, { n: 0 }, { clientInstanceId, concurrencyKey: key });

    startPass(only);
    await waitUntil(() => started.length === 3, "one job per key has started");
    await only.stop();

    expect([...started].sort()).toEqual(["a", "b", "c"]);
  });

  it("refuses a write through control.transaction after the lease was taken over", async () => {
    const clientInstanceId = db.clientInstance("fencing");
    const kind = kindOf("test.fencing");
    const user = await db.store.users.createUser({ clientInstanceId, displayLabel: "Before" });
    const firstStarted = deferred<JobControl>();
    const first = worker(db.store, clientInstanceId, [
      defineJobHandler({
        kind,
        slots: 1,
        async run(_job, control) {
          firstStarted.resolve(control);
          await hang(control);
        }
      })
    ]);
    const second = worker(db.secondStore, clientInstanceId, [
      defineJobHandler({ kind, slots: 1, run: (_job, control) => hang(control) })
    ]);
    await db.store.jobs.enqueue(kind, { n: 1 }, { clientInstanceId, subject: user.id });

    startPass(first);
    const staleControl = await firstStarted.promise;
    const before = await onlyJob(clientInstanceId);
    await expireLeases(clientInstanceId);
    startPass(second);
    await waitUntil(async () => {
      const job = await onlyJob(clientInstanceId);
      return job.status === "running" && job.lease_token !== before.lease_token;
    }, "the second worker holds the lease");

    await expect(
      staleControl.transaction((stores) =>
        stores.users.updateUser({ clientInstanceId, userId: user.id, displayLabel: "After" })
      )
    ).rejects.toBeInstanceOf(JobLeaseLostError);

    const users = await db.store.users.listUsers({ clientInstanceId });
    expect(users.map((candidate) => candidate.displayLabel)).toEqual(["Before"]);
    expect((await onlyJob(clientInstanceId)).attempts).toBe(2);
  });

  it("commits a write through control.transaction while the lease is held", async () => {
    const clientInstanceId = db.clientInstance("held");
    const kind = kindOf("test.held");
    const user = await db.store.users.createUser({ clientInstanceId, displayLabel: "Before" });
    const only = worker(db.store, clientInstanceId, [
      defineJobHandler({
        kind,
        slots: 1,
        async run(_job, control) {
          await control.transaction((stores) =>
            stores.users.updateUser({ clientInstanceId, userId: user.id, displayLabel: "After" })
          );
        }
      })
    ]);
    await db.store.jobs.enqueue(kind, { n: 1 }, { clientInstanceId });

    await only.runDue();

    const users = await db.store.users.listUsers({ clientInstanceId });
    expect(users.map((candidate) => candidate.displayLabel)).toEqual(["After"]);
    expect((await onlyJob(clientInstanceId)).status).toBe("succeeded");
  });

  it("claims the job of a killed worker again after the lease, counts the attempt and buries it at the last one", async () => {
    const clientInstanceId = db.clientInstance("killed");
    // The lease is long, so it is over when the test ends it and not when the machine is slow.
    const kind = kindOf("test.killed", { maxAttempts: 2, backoff: { baseMs: 50, maxMs: 50 } });
    const attempts: number[] = [];
    const exhausted: Array<{ jobId: string; statusSeenFromOutside: string | undefined }> = [];
    const handler: JobHandler<Numbered> = {
      kind,
      slots: 1,
      async run(_job, control) {
        attempts.push(control.attempt);
        await hang(control);
      },
      async onExhausted(job, stores) {
        // Written in the transaction that marks the job dead; another connection still sees
        // the job running.
        await stores.audit.appendAuditEvent({
          clientInstanceId,
          type: "test.exhausted",
          status: "failed",
          subject: job.id,
          correlationId: job.correlationId
        });
        const [outside] = await db.sql<{ status: string }[]>`
          select status from platform_jobs where id = ${job.id}
        `;
        exhausted.push({ jobId: job.id, statusSeenFromOutside: outside?.status });
      }
    };
    /** A worker on a pool of its own that ends without warning: no heartbeat, no release. */
    const killable = async (name: string) => {
      const instance = await createTestInstance({ postgres: { applicationName: name } });
      const killed = worker(instance.stores, clientInstanceId, [defineJobHandler(handler)]);
      return { worker: killed, kill: () => instance.close() };
    };
    const first = await killable("jobs_killed_first");
    const second = await killable("jobs_killed_second");
    const survivor = worker(db.store, clientInstanceId, [defineJobHandler(handler)]);
    const job = await db.store.jobs.enqueue(kind, { n: 1 }, { clientInstanceId });

    startPass(first.worker);
    await waitUntil(() => attempts.length === 1, "the first worker runs the job");
    await first.kill();

    // The lease has to run out before anyone may take the job.
    await second.worker.runDue();
    expect(await onlyJob(clientInstanceId)).toMatchObject({ status: "running", attempts: 1 });

    await expireLeases(clientInstanceId);
    await waitUntil(async () => {
      startPass(second.worker);
      return attempts.length === 2;
    }, "the second worker claims the job after the lease");
    expect(attempts).toEqual([1, 2]);
    expect(await onlyJob(clientInstanceId)).toMatchObject({ status: "running", attempts: 2 });
    await second.kill();

    // The last attempt's lease is live as well: nobody buries a job that may still be running.
    await survivor.runDue();
    expect(await onlyJob(clientInstanceId)).toMatchObject({ status: "running", attempts: 2 });

    await expireLeases(clientInstanceId);
    await waitUntil(async () => {
      await survivor.runDue();
      return (await onlyJob(clientInstanceId)).status === "dead";
    }, "the job is dead after its last attempt");

    expect(attempts).toEqual([1, 2]);
    expect(await onlyJob(clientInstanceId)).toMatchObject({
      status: "dead",
      attempts: 2,
      error_code: "LEASE_EXPIRED"
    });
    expect(exhausted).toEqual([{ jobId: job.id, statusSeenFromOutside: "running" }]);
    const events = await db.store.audit.listAuditEvents({
      clientInstanceId,
      type: "test.exhausted"
    });
    expect(events.map((event) => event.subject)).toEqual([job.id]);
  });

  it("rolls the dead mark back with a failing onExhausted and buries the job without it", async () => {
    const clientInstanceId = db.clientInstance("exhausted_fails");
    const kind = kindOf("test.exhausted_fails", { maxAttempts: 1 });
    const only = worker(db.store, clientInstanceId, [
      defineJobHandler({
        kind,
        slots: 1,
        async run() {
          throw new Error("always");
        },
        async onExhausted(job, stores) {
          await stores.audit.appendAuditEvent({
            clientInstanceId,
            type: "test.exhausted",
            status: "failed",
            subject: job.id,
            correlationId: job.correlationId
          });
          throw new Error("cannot bury");
        }
      })
    ]);
    await db.store.jobs.enqueue(kind, { n: 1 }, { clientInstanceId });

    await only.runDue();

    expect(await onlyJob(clientInstanceId)).toMatchObject({
      status: "dead",
      error_code: "EXHAUSTED_HANDLER_FAILED"
    });
    expect(
      await db.store.audit.listAuditEvents({ clientInstanceId, type: "test.exhausted" })
    ).toEqual([]);
  });

  it("releases a job on stop: claimable at once, with the attempt count from before the claim", async () => {
    const clientInstanceId = db.clientInstance("stop");
    const kind = kindOf("test.stop");
    const attempts: number[] = [];
    const stopped = worker(db.store, clientInstanceId, [
      defineJobHandler({
        kind,
        slots: 1,
        async run(_job, control) {
          attempts.push(control.attempt);
          await hang(control);
        }
      })
    ]);
    await db.store.jobs.enqueue(kind, { n: 1 }, { clientInstanceId });

    startPass(stopped);
    await waitUntil(() => attempts.length === 1, "the job runs");
    expect(await onlyJob(clientInstanceId)).toMatchObject({ status: "running", attempts: 1 });
    await stopped.stop();

    expect(await onlyJob(clientInstanceId)).toMatchObject({
      status: "queued",
      attempts: 0,
      lease_token: null,
      due: true
    });
    const next = worker(db.secondStore, clientInstanceId, [
      defineJobHandler({
        kind,
        slots: 1,
        async run(_job, control) {
          attempts.push(control.attempt);
        }
      })
    ]);
    await next.runDue();
    expect(attempts).toEqual([1, 1]);
    expect(await onlyJob(clientInstanceId)).toMatchObject({ status: "succeeded", attempts: 1 });
    // A stopped worker claims nothing more.
    await db.store.jobs.enqueue(kind, { n: 2 }, { clientInstanceId });
    await stopped.runDue();
    expect((await jobs(clientInstanceId)).map((job) => job.status)).toEqual([
      "succeeded",
      "queued"
    ]);
  });

  it("releases a job whose handler ignores the stop after 20 seconds", async () => {
    const clientInstanceId = db.clientInstance("stop_ignored");
    const kind = kindOf("test.stop_ignored");
    const letGo = deferred<void>();
    let started = false;
    const stopped = worker(db.store, clientInstanceId, [
      defineJobHandler({
        kind,
        slots: 1,
        async run() {
          started = true;
          await letGo.promise;
        }
      })
    ]);
    await db.store.jobs.enqueue(kind, { n: 1 }, { clientInstanceId });
    startPass(stopped);
    await waitUntil(() => started, "the job runs");
    // Passes run one after another, so after this one the pass that claimed the job is over
    // and the stop below reaches its grace without a round trip to the database.
    await stopped.runDue();

    useFakeClockBesidePostgres();
    const stoppedAt = Date.now();
    const stopping = stopped.stop();
    const shortlyBeforeTheGraceEnds = new Promise<void>((resolve) => {
      setTimeout(resolve, 19_900);
    });
    // The fake clock moves for as long as the work takes on the real clock. Up to the end of
    // the grace nothing waits for the database, so the steps may be large. The release is
    // real round trips: in steps of a millisecond the fake clock stays far below the bound
    // however slow the machine is.
    await advanceFakeClockUntilSettled(Promise.race([stopping, shortlyBeforeTheGraceEnds]), 100);
    await advanceFakeClockUntilSettled(stopping, 1);
    const waitedMs = Date.now() - stoppedAt;
    vi.useRealTimers();

    expect(waitedMs).toBeGreaterThanOrEqual(20_000);
    expect(waitedMs).toBeLessThan(25_000);
    expect(await onlyJob(clientInstanceId)).toMatchObject({ status: "queued", attempts: 0 });
    // The late return of the handler changes nothing: its lease is gone.
    letGo.resolve();
    await db.secondStore.audit.listAuditEvents({ clientInstanceId, limit: 1 });
    expect(await onlyJob(clientInstanceId)).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("does not enqueue in a transaction that rolls back, and inserts nothing under a live dedupe key", async () => {
    const clientInstanceId = db.clientInstance("enqueue");
    const kind = kindOf("test.enqueue");

    await expect(
      db.store.transaction(async (stores) => {
        await stores.jobs.enqueue(kind, { n: 1 }, { clientInstanceId });
        throw new Error("subject write failed");
      })
    ).rejects.toThrow("subject write failed");
    expect(await jobs(clientInstanceId)).toEqual([]);

    const first = await db.store.jobs.enqueue(kind, { n: 1 }, { clientInstanceId, dedupeKey: "k" });
    const second = await db.store.jobs.enqueue(
      kind,
      { n: 2 },
      { clientInstanceId, dedupeKey: "k" }
    );
    expect(second.id).toBe(first.id);
    expect(second.payload).toEqual({ n: 1 });
    expect(await jobs(clientInstanceId)).toHaveLength(1);

    // While it runs the key is still live; once it ended the key is free again.
    const only = worker(db.store, clientInstanceId, [
      defineJobHandler({
        kind,
        slots: 1,
        async run() {
          const during = await db.secondStore.jobs.enqueue(
            kind,
            { n: 3 },
            { clientInstanceId, dedupeKey: "k" }
          );
          expect(during.id).toBe(first.id);
        }
      })
    ]);
    await only.runDue();
    expect((await onlyJob(clientInstanceId)).status).toBe("succeeded");
    const third = await db.store.jobs.enqueue(kind, { n: 4 }, { clientInstanceId, dedupeKey: "k" });
    expect(third.id).not.toBe(first.id);
    // Another kind may hold the same key.
    const other = await db.store.jobs.enqueue(
      kindOf("test.enqueue_other"),
      { n: 5 },
      { clientInstanceId, dedupeKey: "k" }
    );
    expect(other.id).not.toBe(third.id);
  });

  it("validates the payload at enqueue and again at claim", async () => {
    const clientInstanceId = db.clientInstance("payload");
    const kind = kindOf("test.payload");
    let ran = false;
    const only = worker(db.store, clientInstanceId, [
      defineJobHandler({
        kind,
        slots: 1,
        async run() {
          ran = true;
        }
      })
    ]);

    await expect(
      Reflect.apply(db.store.jobs.enqueue, db.store.jobs, [
        kind,
        { n: "one" },
        { clientInstanceId }
      ])
    ).rejects.toThrow();
    expect(await jobs(clientInstanceId)).toEqual([]);

    await db.store.jobs.enqueue(kind, { n: 1 }, { clientInstanceId });
    await db.sql`update platform_jobs set payload = '{"n":"one"}'::jsonb where client_instance_id = ${clientInstanceId}`;
    await only.runDue();

    expect(ran).toBe(false);
    expect(await onlyJob(clientInstanceId)).toMatchObject({ status: "failed", attempts: 1 });
  });

  it("retries with a doubling backoff, fails at once on a non-retryable error and buries after the last attempt", async () => {
    const clientInstanceId = db.clientInstance("retry");
    const retried = kindOf("test.retried", {
      maxAttempts: 3,
      backoff: { baseMs: 60_000, maxMs: 90_000 }
    });
    const refused = kindOf("test.refused");
    const exhausted: Job<Numbered>[] = [];
    const only = worker(db.store, clientInstanceId, [
      defineJobHandler({
        kind: retried,
        slots: 1,
        async run() {
          throw new Error("try again");
        },
        async onExhausted(job) {
          exhausted.push(job);
        }
      }),
      defineJobHandler({
        kind: refused,
        slots: 1,
        async run() {
          throw new NonRetryableJobError("The subject is gone");
        }
      })
    ]);
    const job = await db.store.jobs.enqueue(retried, { n: 1 }, { clientInstanceId });
    const other = await db.store.jobs.enqueue(refused, { n: 2 }, { clientInstanceId });
    const state = async () => {
      const [row] = await db.sql<{ status: string; attempts: number; run_after: Date }[]>`
        select status, attempts, run_after from platform_jobs where id = ${job.id}
      `;
      return required(row);
    };
    const databaseNow = async () =>
      required((await db.sql<{ now: Date }[]>`select clock_timestamp() as now`)[0]).now.getTime();
    /**
     * Runs a pass in which the attempt fails and returns the backoff it was given, as the two
     * bounds the database's clock gives: the attempt ended between the two readings, however
     * long the pass took.
     */
    const backoffOfFailedPass = async () => {
      const before = await databaseNow();
      await only.runDue();
      const after = await databaseNow();
      const runAfter = (await state()).run_after.getTime();
      return { atLeast: runAfter - after, atMost: runAfter - before };
    };
    const makeDue = () => db.sql`update platform_jobs set run_after = now() where id = ${job.id}`;

    const first = await backoffOfFailedPass();
    expect(await state()).toMatchObject({ status: "queued", attempts: 1 });
    expect(first.atLeast).toBeLessThanOrEqual(60_000);
    expect(first.atMost).toBeGreaterThanOrEqual(60_000);
    const [refusedRow] = await db.sql<{ status: string; error_message: string }[]>`
      select status, error_message from platform_jobs where id = ${other.id}
    `;
    expect(refusedRow).toEqual({ status: "failed", error_message: "The subject is gone" });

    // Not due yet: another pass leaves it alone.
    await only.runDue();
    expect((await state()).attempts).toBe(1);

    // Doubled it would be 120 seconds; the kind's limit holds it at 90.
    await makeDue();
    const second = await backoffOfFailedPass();
    expect(await state()).toMatchObject({ status: "queued", attempts: 2 });
    expect(second.atLeast).toBeLessThanOrEqual(90_000);
    expect(second.atMost).toBeGreaterThanOrEqual(90_000);

    await makeDue();
    await only.runDue();
    expect(await state()).toMatchObject({ status: "dead", attempts: 3 });
    expect(exhausted.map((entry) => entry.payload)).toEqual([{ n: 1 }]);
    // The stored error is the envelope's: an unknown error tells nothing.
    const [dead] = await db.sql<{ error_code: string; error_message: string }[]>`
      select error_code, error_message from platform_jobs where id = ${job.id}
    `;
    expect(dead?.error_code).toBe("INTERNAL");
    expect(dead?.error_message).not.toContain("try again");
  });

  it("leaves a kind that no worker serves queued", async () => {
    const clientInstanceId = db.clientInstance("unserved");
    const only = worker(db.store, clientInstanceId, [
      defineJobHandler({ kind: kindOf("test.served"), slots: 1, async run() {} })
    ]);
    await db.store.jobs.enqueue(kindOf("test.unserved"), { n: 1 }, { clientInstanceId });

    await only.runDue();

    expect(await onlyJob(clientInstanceId)).toMatchObject({ status: "queued", attempts: 0 });
  });

  describe("schedules", () => {
    const tick = (kind: string) =>
      defineJobKind({
        kind,
        payloadSchema: scheduledJobPayloadSchema,
        maxAttempts: 1,
        backoff: { baseMs: 0, maxMs: 0 },
        leaseMs: 60_000,
        concurrency: { global: 1 }
      });

    it("produces one tick per interval with two workers, the first one due at once", async () => {
      const clientInstanceId = db.clientInstance("schedule");
      const kind = tick("test.tick");
      const hour = 60 * 60 * 1000;
      const schedule = defineSchedule({ kind, every: hour });
      let ticks = 0;
      let overlapping = 0;
      let highest = 0;
      const handler = () =>
        defineJobHandler({
          kind,
          slots: 1,
          async run() {
            overlapping += 1;
            highest = Math.max(highest, overlapping);
            await db.store.audit.listAuditEvents({ clientInstanceId, limit: 1 });
            overlapping -= 1;
            ticks += 1;
          }
        });
      const first = worker(db.store, clientInstanceId, [handler()], [schedule]);
      const second = worker(db.secondStore, clientInstanceId, [handler()], [schedule]);

      const bothPass = () => Promise.all([first.runDue(), second.runDue()]);

      for (let expected = 1; expected <= 4; expected += 1) {
        await bothPass();
        expect(ticks).toBe(expected);
        const rows = await jobs(clientInstanceId);
        expect(rows.map((row) => row.status)).toEqual([
          ...Array.from({ length: expected }, () => "succeeded"),
          "queued"
        ]);
        // The next tick is due one interval after the end of this one, by the database clock.
        const ended = required(required(rows[expected - 1]).finished_at).getTime();
        const next = required(rows[expected]);
        expect(next.run_after.getTime() - ended).toBe(hour);
        // Until then passes of both workers leave it alone.
        await bothPass();
        expect(ticks).toBe(expected);
        // As if the interval had passed.
        await db.sql`update platform_jobs set run_after = now() where id = ${next.id}`;
      }
      expect(highest).toBe(1);
    });

    it("enqueues the next tick when a tick fails, and a failed tick is never dead", async () => {
      const clientInstanceId = db.clientInstance("schedule_fails");
      const kind = tick("test.tick_fails");
      const only = worker(
        db.store,
        clientInstanceId,
        [
          defineJobHandler({
            kind,
            slots: 1,
            async run() {
              throw new Error("tick failed");
            }
          })
        ],
        [defineSchedule({ kind, every: 3_600_000 })]
      );

      await only.runDue();

      const rows = await jobs(clientInstanceId);
      expect(rows.map((row) => row.status)).toEqual(["failed", "queued"]);
      expect(required(rows[1]).due).toBe(false);
    });

    it("fails a tick whose worker was killed and enqueues the next one", async () => {
      const clientInstanceId = db.clientInstance("schedule_killed");
      const kind = tick("test.tick_killed");
      const schedule = defineSchedule({ kind, every: 3_600_000 });
      let started = false;
      const first = worker(
        db.store,
        clientInstanceId,
        [
          defineJobHandler({
            kind,
            slots: 1,
            async run(_job, control) {
              started = true;
              await hang(control);
            }
          })
        ],
        [schedule]
      );
      const second = worker(
        db.secondStore,
        clientInstanceId,
        [defineJobHandler({ kind, slots: 1, async run() {} })],
        [schedule]
      );
      startPass(first);
      await waitUntil(() => started, "the tick runs");
      await expireLeases(clientInstanceId);

      await second.runDue();

      const rows = await jobs(clientInstanceId);
      expect(rows.map((row) => row.status)).toEqual(["failed", "queued"]);
      expect(required(rows[0]).error_code).toBe("LEASE_EXPIRED");
    });
  });

  it("prunes succeeded and cancelled jobs after 7 days and failed and dead jobs after 30", async () => {
    const clientInstanceId = db.clientInstance("prune");
    const kind = kindOf("test.prune");
    const seed = async (status: string, endedDaysAgo: number | null) => {
      const job = await db.store.jobs.enqueue(kind, { n: 1 }, { clientInstanceId });
      await db.sql`
        update platform_jobs
        set status = ${status},
            finished_at = ${endedDaysAgo === null ? null : db.sql`now() - make_interval(days => ${endedDaysAgo})`}
        where id = ${job.id}
      `;
      return job.id;
    };
    const kept = [
      await seed("succeeded", 6),
      await seed("cancelled", 6),
      await seed("failed", 29),
      await seed("dead", 29),
      await seed("queued", null),
      await seed("running", null)
    ];
    await seed("succeeded", 8);
    await seed("cancelled", 8);
    await seed("failed", 31);
    await seed("dead", 31);

    const result = await db.store.jobs.pruneEndedJobs({ clientInstanceId });

    expect(result).toEqual({ completedCount: 2, failedCount: 2 });
    expect((await jobs(clientInstanceId)).map((job) => job.id).sort()).toEqual([...kept].sort());
  });
});

/** Starts a pass whose handler blocks: the test reads the rows, not what the pass returns. */
function startPass(running: JobWorker): void {
  running.runDue().catch(() => undefined);
}
