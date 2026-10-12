import { mkdir, readdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import { AGENT_RUN_IDLE_LIMIT_MS } from "@vivd-catalyst/agent-runtime";
import {
  JOB_UNCLAIMED_MS,
  JOB_WORKER_CHECK_INTERVAL_MS,
  type PlatformStores,
  type WorkspaceCommand
} from "@vivd-catalyst/core";
import {
  WORKSPACE_COMMAND_CANCELLATION_CHECK_INTERVAL_MS,
  WORKSPACE_COMMAND_HEARTBEAT_MS,
  WORKSPACE_COMMAND_LEASE_MS,
  WORKSPACE_COMMAND_NO_WORKER_MESSAGE,
  createWorkspaceCommandClient
} from "@vivd-catalyst/tool-execution";
import { describe, expect, it, vi } from "vitest";
import { required, waitUntil } from "./support/assertions";
import {
  advanceFakeClockUntilSettled,
  settleOnFakeClock,
  useFakeClockBesidePostgres
} from "./support/fake-clock";
import { useJobExecutorHarness } from "./support/job-executor-harness";
import { usePostgresSuite } from "./support/postgres-suite";
import {
  successResult,
  useWorkspaceCommandJobFixture
} from "./support/workspace-command-job-fixture";

describe("workspace commands on the job executor", () => {
  const db = usePostgresSuite("command_jobs");
  const harness = useJobExecutorHarness(db);
  const { createFixture, commandJobs } = useWorkspaceCommandJobFixture(db, harness);

  it("queues the command with its job and runs it once", async () => {
    const fixture = await createFixture("once");
    const queued = await fixture.enqueue("printf done");

    expect(await commandJobs(fixture)).toEqual([
      {
        status: "queued",
        attempts: 0,
        max_attempts: 1,
        subject: queued.id,
        concurrency_key: fixture.workspace.id,
        error_code: null
      }
    ]);

    const worker = fixture.worker();
    const run = worker.runDue();
    (await fixture.executor.next()).complete(successResult({ stdoutPreview: "done" }));
    await run;
    // Nothing is left to claim: a second pass starts no process.
    await worker.runDue();

    expect(fixture.executor.calls).toHaveLength(1);
    expect(await fixture.command(queued)).toMatchObject({
      status: "completed",
      attempts: 1,
      output: { stdoutPreview: "done" },
      leaseToken: undefined
    });
    expect(await commandJobs(fixture)).toMatchObject([{ status: "succeeded", attempts: 1 }]);
  });

  it("queues no command when its job cannot be queued", async () => {
    const fixture = await createFixture("atomic");
    const withoutJobs: Pick<PlatformStores, "executionWorkspaces" | "jobs" | "transaction"> = {
      executionWorkspaces: db.store.executionWorkspaces,
      jobs: db.store.jobs,
      transaction: (fn) =>
        db.store.transaction((stores) =>
          fn({
            ...stores,
            jobs: { ...stores.jobs, enqueue: () => Promise.reject(new Error("no job today")) }
          })
        )
    };

    await expect(fixture.enqueue("printf never", withoutJobs)).rejects.toThrow("no job today");

    const rows = await db.sql`
      select id from workspace_commands where client_instance_id = ${fixture.clientInstanceId}`;
    expect(rows).toHaveLength(0);
    expect(await commandJobs(fixture)).toHaveLength(0);
  });

  it("copies the job's lease onto the command and renews it with the job's heartbeat", async () => {
    const fixture = await createFixture("mirror");
    const beat = harness.heartbeatsByHand();
    const queued = await fixture.enqueue("sleep 60");
    const run = fixture.worker().runDue();
    const execution = await fixture.executor.next();

    const job = await harness.onlyJob(fixture.clientInstanceId);
    expect(await fixture.command(queued)).toMatchObject({
      status: "running",
      leaseOwner: `job:${job.id}`,
      leaseToken: job.lease_token
    });

    // As a worker of the previous release would see it shortly before the lease runs out.
    await db.sql`
      update workspace_commands set lease_expires_at = now() + interval '1 second'
      where id = ${queued.id}`;
    beat();
    await waitUntil(
      async () => (await commandLease(queued)).minutes_left > 1,
      "the heartbeat extended the lease on the command"
    );

    execution.complete(successResult());
    await run;
    expect(await fixture.command(queued)).toMatchObject({ status: "completed" });
  });

  it("fails the command of a worker that was lost, and does not run it again", async () => {
    const fixture = await createFixture("lost");
    const beat = harness.heartbeatsByHand();
    const queued = await fixture.enqueue("sleep 60");
    const lostWorker = fixture.worker();
    const lostRun = lostWorker.runDue();
    const execution = await fixture.executor.next();

    // The worker stops renewing: its lease runs out, by the database's clock.
    await harness.expireLeases(fixture.clientInstanceId);
    await fixture.worker().runDue();

    expect(await fixture.command(queued)).toMatchObject({
      status: "failed",
      attempts: 2,
      error: { code: "WORKSPACE_COMMAND_WORKER_LOST", category: "worker_lost" },
      leaseToken: undefined
    });
    expect(await commandJobs(fixture)).toMatchObject([
      { status: "dead", attempts: 1, error_code: "LEASE_EXPIRED" }
    ]);

    // The lost worker comes back to life. Its next heartbeat tells it that the lease is gone,
    // which ends the process group, and the result it then reports is refused.
    beat();
    await waitUntil(() => execution.signal?.aborted === true, "the process is told to end");
    expect(execution.signal?.reason).toBe("Workspace command lost its job lease");
    await lostRun;

    expect(await fixture.command(queued)).toMatchObject({
      status: "failed",
      error: { category: "worker_lost" }
    });
    // No later pass runs it a second time.
    await fixture.worker().runDue();
    expect(fixture.executor.calls).toHaveLength(1);
    expect(await commandJobs(fixture)).toMatchObject([{ status: "dead", attempts: 1 }]);
  });

  it("refuses the result of a worker whose lease ran out before another worker noticed", async () => {
    const fixture = await createFixture("fenced");
    harness.heartbeatsByHand();
    const queued = await fixture.enqueue("printf late");
    const run = fixture.worker().runDue();
    const execution = await fixture.executor.next();

    await harness.expireLeases(fixture.clientInstanceId);
    execution.complete(successResult({ stdoutPreview: "late" }));
    await run;

    // The fence: the command is not completed through a lease that is over.
    expect(await fixture.command(queued)).toMatchObject({ status: "running", attempts: 1 });
    await fixture.worker().runDue();
    expect(await fixture.command(queued)).toMatchObject({
      status: "failed",
      error: { category: "worker_lost" }
    });
  });

  it("ends the process of a cancelled command and frees the workspace for the next one", async () => {
    const fixture = await createFixture("cancel", { realProcesses: true });
    const handle = await fixture.client.enqueue(
      { kind: "execution_workspace", id: fixture.workspace.id },
      fixture.request("sleep 60")
    );
    const worker = fixture.worker({
      cancellationCheckIntervalMs: WORKSPACE_COMMAND_CANCELLATION_CHECK_INTERVAL_MS
    });
    const run = worker.runDue();
    await waitUntil(
      async () => (await fixture.command(handle.command))?.status === "running",
      "the command runs"
    );

    // A user Stop: the run's signal is aborted while the tool waits for the result.
    const stopped = new AbortController();
    stopped.abort();
    const result = await fixture.client.await(handle, { signal: stopped.signal });
    expect(result.status).toBe("cancelled");

    // `sleep 60` ends only when its process group is killed: the pass returns because the
    // handler saw the request at its next look, which the product makes every second.
    await run;
    expect(WORKSPACE_COMMAND_CANCELLATION_CHECK_INTERVAL_MS).toBeLessThanOrEqual(2000);
    expect(await fixture.command(handle.command)).toMatchObject({
      status: "cancelled",
      cancellationReason: "Workspace command was cancelled with its agent run",
      output: { exitCode: 130 }
    });
    expect(await commandJobs(fixture)).toMatchObject([{ status: "succeeded", attempts: 1 }]);

    // The job is ended, so the workspace's next command is claimed at once.
    const next = await fixture.enqueue("printf next");
    await worker.runDue();
    expect(await fixture.command(next)).toMatchObject({
      status: "completed",
      output: { stdoutPreview: "next" }
    });
  });

  it("ends the job of a command that was cancelled before it started, without a process", async () => {
    const fixture = await createFixture("cancel_queued");
    const handle = await fixture.client.enqueue(
      { kind: "execution_workspace", id: fixture.workspace.id },
      fixture.request("sleep 60")
    );
    const stopped = new AbortController();
    stopped.abort();

    await expect(fixture.client.await(handle, { signal: stopped.signal })).resolves.toMatchObject({
      status: "cancelled",
      command: { status: "cancelled" }
    });
    await fixture.worker().runDue();

    expect(fixture.executor.calls).toHaveLength(0);
    // Withdrawn with the cancellation: no worker claims it, and it never reads as succeeded.
    expect(await commandJobs(fixture)).toMatchObject([
      { status: "cancelled", attempts: 0, error_code: "WITHDRAWN" }
    ]);
  });

  it("runs the commands of one workspace in order, one at a time, beside another workspace", async () => {
    const fixture = await createFixture("order");
    const other = await fixture.secondWorkspace();
    const first = await fixture.enqueue("first");
    const second = await fixture.enqueue("second");
    const elsewhere = await fixture.enqueue("elsewhere", db.store, other);
    const worker = fixture.worker({ slots: 3 });

    const firstPass = worker.runDue();
    const started = [await fixture.executor.next(), await fixture.executor.next()];
    expect(started.map((execution) => execution.command.command).sort()).toEqual([
      "elsewhere",
      "first"
    ]);
    // The third slot stays empty: the workspace of `second` has a command running.
    expect(await fixture.command(second)).toMatchObject({ status: "queued", attempts: 0 });
    expect(await commandJobs(fixture)).toMatchObject([
      { subject: first.id, status: "running" },
      { subject: second.id, status: "queued", attempts: 0 },
      { subject: elsewhere.id, status: "running" }
    ]);

    for (const execution of started) execution.complete(successResult());
    await firstPass;
    const secondPass = worker.runDue();
    const secondExecution = await fixture.executor.next();
    // Observe the first command's recorded end when the second process starts. Their
    // timestamps come from different clocks: completedAt from Node, startedAt from Postgres.
    expect(await fixture.command(first)).toMatchObject({ status: "completed" });
    expect(await fixture.command(second)).toMatchObject({ status: "running", attempts: 1 });
    secondExecution.complete(successResult());
    await secondPass;

    expect(fixture.executor.calls.map((call) => call.command.command)).toEqual([
      ...started.map((execution) => execution.command.command),
      "second"
    ]);
    expect(await fixture.command(second)).toMatchObject({ status: "completed" });
  });

  it("cancels the running command when the worker stops, and no worker runs it again", async () => {
    const fixture = await createFixture("stop");
    const queued = await fixture.enqueue("sleep 60");
    const worker = fixture.worker();
    worker.start();
    const execution = await fixture.executor.next();
    expect(execution.signal?.aborted).toBe(false);

    // Nothing else ends this execution, so a stop that did not cancel it would wait out its
    // grace period and leave the command running.
    await worker.stop();

    expect(execution.signal?.reason).toBe("Workspace command worker is stopping");
    expect(await fixture.command(queued)).toMatchObject({
      status: "cancelled",
      cancellationReason: "Workspace command worker is stopping",
      output: { exitCode: 130 }
    });
    await fixture.worker().runDue();
    expect(fixture.executor.calls).toHaveLength(1);
    // The attempt that ran the command ended with it: the job is done, not waiting for a claim.
    expect(await commandJobs(fixture)).toMatchObject([{ status: "succeeded", attempts: 1 }]);
  });

  it("keeps a running command when the workspace cleanup races with it, and records its end", async () => {
    const fixture = await createFixture("cleanup_race", { withAuditRecorder: true });
    const queued = await fixture.enqueue("python3 calculate.py");
    const run = fixture.worker().runDue();
    const execution = await fixture.executor.next();

    await db.store.executionWorkspaces.markExecutionWorkspaceDeleted({
      clientInstanceId: fixture.clientInstanceId,
      conversationId: fixture.workspace.conversationId,
      deletedAt: new Date().toISOString()
    });
    expect(await fixture.command(queued)).toMatchObject({ status: "running" });

    execution.complete(successResult({ stdoutPreview: "finished after cleanup" }));
    await run;

    expect(await fixture.command(queued)).toMatchObject({
      status: "completed",
      output: { stdoutPreview: "finished after cleanup" }
    });
    const events = await db.store.audit.listAuditEvents({
      clientInstanceId: fixture.clientInstanceId,
      limit: 20
    });
    expect(events.map((event) => [event.type, event.subject])).toEqual(
      expect.arrayContaining([
        ["workspace_command.running", queued.id],
        ["workspace_command.completed", queued.id]
      ])
    );
  });

  it("removes hydrated workspace directories that went unused, on its schedule", async () => {
    const fixture = await createFixture("temp_state");
    const orphan = join(fixture.commandRootDirectory, "catalyst-workspace-orphaned");
    await mkdir(orphan, { recursive: true });
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(orphan, longAgo, longAgo);

    // A worker that starts makes sure of its ticks; a tick that had to be made is due at once.
    await fixture.worker({}, { schedules: true }).runDue();

    await expect(readdir(fixture.commandRootDirectory)).resolves.not.toContain(
      "catalyst-workspace-orphaned"
    );
  });

  it("records the result of a command that was stopped after its process had ended", async () => {
    const fixture = await createFixture("late_stop");
    const handle = await fixture.client.enqueue(
      { kind: "execution_workspace", id: fixture.workspace.id },
      fixture.request("printf done")
    );
    // The handler does not look at the row again before the process ends, as when the Stop
    // lands between the end of the process and the write of its result.
    const worker = fixture.worker({ cancellationCheckIntervalMs: 60 * 60 * 1000 });
    const run = worker.runDue();
    const execution = await fixture.executor.next();

    const stopped = new AbortController();
    stopped.abort();
    await expect(fixture.client.await(handle, { signal: stopped.signal })).resolves.toMatchObject({
      status: "cancelled",
      command: { status: "cancelling" }
    });
    execution.complete(successResult({ stdoutPreview: "done" }));
    await run;

    // The process did finish: its result is the record, and the row holds no lease.
    const recorded = await fixture.command(handle.command);
    expect(recorded).toMatchObject({
      status: "completed",
      output: { exitCode: 0, stdoutPreview: "done" },
      leaseToken: undefined
    });
    expect(recorded?.cancellationRequestedAt).toBeDefined();
    expect(await commandJobs(fixture)).toMatchObject([{ status: "succeeded", attempts: 1 }]);

    // Nothing waits behind it: the workspace's next command runs in the next pass.
    const next = await fixture.enqueue("printf next");
    const nextPass = worker.runDue();
    (await fixture.executor.next()).complete(successResult());
    await nextPass;
    expect(await fixture.command(next)).toMatchObject({ status: "completed" });
  });

  it("fails the job when its result is refused and the command is not ended", async () => {
    const fixture = await createFixture("refused");
    const queued = await fixture.enqueue("printf late");
    const run = fixture.worker().runDue();
    const execution = await fixture.executor.next();

    // Another holder's lease stands on the row, so the store refuses this attempt's result.
    await db.sql`
      update workspace_commands
      set lease_owner = 'legacy-worker', lease_token = 'lease-legacy',
          lease_expires_at = now() - interval '1 second'
      where id = ${queued.id}`;
    execution.complete(successResult());
    await run;

    // The refusal is not passed over: the job is dead, and its end ended the command.
    expect(await commandJobs(fixture)).toMatchObject([{ status: "dead", attempts: 1 }]);
    expect(await fixture.command(queued)).toMatchObject({
      status: "failed",
      error: { code: "WORKSPACE_COMMAND_WORKER_LOST" },
      leaseToken: undefined
    });
  });

  it("frees the workspace of a killed worker after one lease of two minutes", async () => {
    expect(WORKSPACE_COMMAND_LEASE_MS).toBe(2 * 60 * 1000);
    expect(WORKSPACE_COMMAND_HEARTBEAT_MS).toBe(30 * 1000);
    const fixture = await createFixture("killed");
    harness.heartbeatsByHand();
    const first = await fixture.enqueue("sleep 60");
    const second = await fixture.enqueue("printf second");
    const killed = fixture.worker();
    const killedPass = killed.runDue();
    await fixture.executor.next();
    // The lease the job took is the kind's: it ends two minutes after the claim.
    const [claimed] = await db.sql<{ seconds_left: number }[]>`
      select extract(epoch from lease_expires_at - now())::float8 as seconds_left
      from platform_jobs
      where client_instance_id = ${fixture.clientInstanceId} and status = 'running'`;
    expect(required(claimed).seconds_left).toBeGreaterThan(60);
    expect(required(claimed).seconds_left).toBeLessThanOrEqual(120);
    expect(await fixture.command(second)).toMatchObject({ status: "queued" });

    // The worker is killed: no heartbeat comes, and the lease runs out.
    await harness.expireLeases(fixture.clientInstanceId);
    const survivor = fixture.worker();
    await survivor.runDue();
    expect(await fixture.command(first)).toMatchObject({
      status: "failed",
      error: { category: "worker_lost" }
    });
    const pass = survivor.runDue();
    const execution = await fixture.executor.next();
    expect(execution.command.command).toBe("printf second");
    execution.complete(successResult());
    await pass;
    expect(await fixture.command(second)).toMatchObject({ status: "completed" });
    // The test's own process of the killed worker is ended here; it changes nothing recorded.
    await killed.stop();
    await killedPass;
    expect(await fixture.command(first)).toMatchObject({ status: "failed" });
  });

  it("ends the process of a job that lost its lease before the workspace's next command starts", async () => {
    const fixture = await createFixture("lost_alive");
    const beat = harness.heartbeatsByHand();
    const first = await fixture.enqueue("sleep 60");
    const second = await fixture.enqueue("printf second");
    const buried = fixture.worker().runDue();
    const execution = await fixture.executor.next();

    // The worker lives, but its lease ran out. Its next heartbeat finds that.
    await harness.expireLeases(fixture.clientInstanceId);
    beat();
    await buried;
    expect(execution.signal?.aborted).toBe(true);
    expect(execution.signal?.reason).toBe("Workspace command lost its job lease");
    // The process is over and nothing else started; its result was refused with the lease.
    expect(fixture.executor.calls).toHaveLength(1);
    expect(await fixture.command(first)).toMatchObject({ status: "running" });
    expect(await fixture.command(second)).toMatchObject({ status: "queued" });

    const survivor = fixture.worker();
    await survivor.runDue();
    const pass = survivor.runDue();
    (await fixture.executor.next()).complete(successResult());
    await pass;
    expect(await fixture.command(first)).toMatchObject({
      status: "failed",
      error: { category: "worker_lost" }
    });
    expect(await fixture.command(second)).toMatchObject({ status: "completed" });
    expect(fixture.executor.calls).toHaveLength(2);
  });

  it("fails a command whose workspace is no longer active, without a process", async () => {
    const fixture = await createFixture("inactive");
    const queued = await fixture.enqueue("printf never");
    await db.sql`
      update execution_workspaces set status = 'deleted', deleted_at = now()
      where id = ${fixture.workspace.id}`;

    await fixture.worker().runDue();

    expect(fixture.executor.calls).toHaveLength(0);
    expect(await fixture.command(queued)).toMatchObject({
      status: "failed",
      error: { code: "WORKSPACE_NOT_FOUND" },
      leaseToken: undefined
    });
    expect(await commandJobs(fixture)).toMatchObject([{ status: "succeeded", attempts: 1 }]);
  });

  async function commandLease(command: Pick<WorkspaceCommand, "id">) {
    const [row] = await db.sql<{ minutes_left: number }[]>`
      select extract(epoch from lease_expires_at - now())::float8 / 60 as minutes_left
      from workspace_commands where id = ${command.id}`;
    return required(row);
  }
});

describe("a workspace command no worker takes", () => {
  const db = usePostgresSuite("command_no_worker");
  const harness = useJobExecutorHarness(db);
  const { createFixture, commandJobs } = useWorkspaceCommandJobFixture(db, harness);

  /**
   * Moves the fake clock by `ms` in steps the waiting client can follow: it sleeps half a
   * second between two reads, and each read is a real round trip that one move would outrun.
   */
  async function passInSteps(ms: number, handle: { command: WorkspaceCommand }): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await vi.advanceTimersByTimeAsync(250);
      await settleOnFakeClock(
        db.store.executionWorkspaces.getWorkspaceCommand({
          clientInstanceId: handle.command.clientInstanceId,
          commandId: handle.command.id
        })
      );
    }
  }

  /** The client as the API builds it: its own poll interval and the limits of the product. */
  const productClient = () =>
    createWorkspaceCommandClient({ stores: db.store, now: () => new Date().toISOString() });

  it("is given up after the unclaimed time with the reason, its job is withdrawn, and the next command runs when a worker is back", async () => {
    const fixture = await createFixture("no_worker");
    const client = productClient();
    useFakeClockBesidePostgres();
    const handle = await settleOnFakeClock(
      client.enqueue(
        { kind: "execution_workspace", id: fixture.workspace.id },
        fixture.request("ls")
      )
    );
    const queuedAt = Date.now();

    const result = await advanceFakeClockUntilSettled(client.await(handle, {}), 250);

    const waited = Date.now() - queuedAt;
    expect(result).toMatchObject({
      status: "no_worker",
      reason: WORKSPACE_COMMAND_NO_WORKER_MESSAGE,
      command: { status: "cancelled", cancellationReason: "No worker took the workspace command" }
    });
    // The agent passes it on to a person: an administrator is named, the worker is not.
    expect(WORKSPACE_COMMAND_NO_WORKER_MESSAGE).toMatch(
      /^Code execution is unavailable right now.* an administrator has to look into it/u
    );
    expect(WORKSPACE_COMMAND_NO_WORKER_MESSAGE).not.toMatch(/worker/iu);
    // Not before the limit, and long before the idle limit of a run would have ended the run.
    expect(waited).toBeGreaterThanOrEqual(JOB_UNCLAIMED_MS);
    expect(waited).toBeLessThan(AGENT_RUN_IDLE_LIMIT_MS);
    vi.useRealTimers();
    // Withdrawn, not left queued: the worker that comes back has nothing of it to run.
    expect(await commandJobs(fixture)).toMatchObject([
      { status: "cancelled", attempts: 0, error_code: "WITHDRAWN" }
    ]);
    const worker = fixture.worker();
    await worker.runDue();
    expect(fixture.executor.calls).toHaveLength(0);

    worker.start();
    const next = await fixture.client.enqueue(
      { kind: "execution_workspace", id: fixture.workspace.id },
      fixture.request("printf back")
    );
    const waiting = fixture.client.await(next, {});
    (await fixture.executor.next()).complete(successResult({ stdoutPreview: "back" }));

    expect(await waiting).toMatchObject({
      status: "settled",
      command: { status: "completed", output: { stdoutPreview: "back" } }
    });
    expect(fixture.executor.calls.map((call) => call.command.command)).toEqual(["printf back"]);
  });

  it("runs a command once that a worker claims just before the unclaimed time, however long it then runs", async () => {
    const fixture = await createFixture("claimed_late");
    const client = productClient();
    useFakeClockBesidePostgres();
    const handle = await settleOnFakeClock(
      client.enqueue(
        { kind: "execution_workspace", id: fixture.workspace.id },
        fixture.request("ls")
      )
    );
    let result: Awaited<ReturnType<typeof client.await>> | undefined;
    const waiting = client.await(handle, {}).then((ended) => {
      result = ended;
    });
    // 700 ms before the limit: no worker has shown itself yet.
    await vi.advanceTimersByTimeAsync(JOB_UNCLAIMED_MS - 700);

    const pass = fixture.worker().runDue();
    const execution = await settleOnFakeClock(fixture.executor.next());
    // Past the limit and past the next look at the queue, while the command still runs.
    await passInSteps(700 + JOB_WORKER_CHECK_INTERVAL_MS + 1_300, handle);
    await settleOnFakeClock(fixture.command(handle.command));
    expect(result).toBeUndefined();

    execution.complete(successResult({ stdoutPreview: "listed" }));
    await settleOnFakeClock(pass);
    await advanceFakeClockUntilSettled(waiting, 250);

    expect(result).toMatchObject({
      status: "settled",
      command: { status: "completed", attempts: 1, output: { stdoutPreview: "listed" } }
    });
    expect(fixture.executor.calls).toHaveLength(1);
    expect(await settleOnFakeClock(commandJobs(fixture))).toMatchObject([
      { status: "succeeded", attempts: 1 }
    ]);
  });

  /** As if the process of the worker had been killed: its leases run out and it reports nothing. */
  async function killWorker(fixture: { clientInstanceId: string }, reports: "silent" | "none") {
    await db.sql`
      update platform_jobs set lease_expires_at = now() - interval '1 second'
      where client_instance_id = ${fixture.clientInstanceId} and status = 'running'`;
    if (reports === "none") {
      await db.sql`
        delete from job_worker_reports where client_instance_id = ${fixture.clientInstanceId}`;
    } else {
      await db.sql`
        update job_worker_reports
        set seen_at = seen_at - interval '47 seconds'
        where client_instance_id = ${fixture.clientInstanceId}`;
    }
  }

  // The incident: the worker died while a command ran. Its job stays `running` until a worker
  // buries it, and no worker comes.
  it.each([
    { reports: "silent" as const, name: "its last report is 47 seconds old" },
    {
      reports: "none" as const,
      name: "it was a worker of the release before, which reports nothing"
    }
  ])(
    "is given up within the limit when the worker died while another command ran: $name",
    async ({ reports }) => {
      const fixture = await createFixture(`died_${reports}`);
      await fixture.enqueue("sleep 600");
      const pass = fixture.worker().runDue();
      const left = await fixture.executor.next();
      await killWorker(fixture, reports);
      const other = await fixture.secondWorkspace();
      const client = productClient();
      useFakeClockBesidePostgres();
      const handle = await settleOnFakeClock(
        client.enqueue({ kind: "execution_workspace", id: other.id }, fixture.request("ls"))
      );
      const queuedAt = Date.now();

      const result = await advanceFakeClockUntilSettled(client.await(handle, {}), 250);

      expect(result).toMatchObject({ status: "no_worker", command: { status: "cancelled" } });
      expect(Date.now() - queuedAt).toBeGreaterThanOrEqual(JOB_UNCLAIMED_MS);
      expect(Date.now() - queuedAt).toBeLessThan(2 * JOB_UNCLAIMED_MS);
      vi.useRealTimers();
      left.complete(successResult());
      await pass.catch(() => undefined);
    }
  );

  it("waits for a worker that reports, however long it claims nothing", async () => {
    const fixture = await createFixture("reporting");
    // A worker of the kind is up and reports through the whole wait.
    await fixture.worker().runDue();
    await db.sql`
      update job_worker_reports set seen_at = now() + interval '10 minutes'
      where client_instance_id = ${fixture.clientInstanceId}`;
    const client = productClient();
    const stopped = new AbortController();
    useFakeClockBesidePostgres();
    const handle = await settleOnFakeClock(
      client.enqueue(
        { kind: "execution_workspace", id: fixture.workspace.id },
        fixture.request("ls")
      )
    );
    let ended = false;
    const waiting = client.await(handle, { signal: stopped.signal }).finally(() => {
      ended = true;
    });

    // Past the limit and four more looks at the queue.
    await passInSteps(JOB_UNCLAIMED_MS + 4 * JOB_WORKER_CHECK_INTERVAL_MS + 1_300, handle);
    expect(await settleOnFakeClock(fixture.command(handle.command))).toMatchObject({
      status: "queued"
    });
    expect(ended).toBe(false);

    stopped.abort();
    await advanceFakeClockUntilSettled(waiting, 250);
  });

  it("goes on waiting for a command that a worker claims in the moment it is given up", async () => {
    const fixture = await createFixture("claimed_at_give_up");
    let pass: Promise<void> | undefined;
    // The queue is read, it shows no worker, and before the client acts on it a worker claims.
    const jobs: typeof db.store.jobs = {
      ...db.store.jobs,
      async readKindActivity(input) {
        const read = await db.store.jobs.readKindActivity(input);
        if (!pass) {
          pass = fixture.worker().runDue();
          await fixture.executor.next();
        }
        return read;
      }
    };
    const client = createWorkspaceCommandClient({
      stores: { ...db.store, jobs },
      now: () => new Date().toISOString()
    });
    useFakeClockBesidePostgres();
    const handle = await settleOnFakeClock(
      client.enqueue(
        { kind: "execution_workspace", id: fixture.workspace.id },
        fixture.request("ls")
      )
    );
    let result: Awaited<ReturnType<typeof client.await>> | undefined;
    const waiting = client.await(handle, {}).then((ended) => {
      result = ended;
    });

    await vi.advanceTimersByTimeAsync(JOB_UNCLAIMED_MS - 700);
    for (let step = 0; step < 40 && fixture.executor.calls.length === 0; step += 1) {
      await vi.advanceTimersByTimeAsync(250);
      await settleOnFakeClock(fixture.command(handle.command));
    }
    const execution = required(fixture.executor.calls[0]);
    // Two more looks at the row: the client has acted on what it read.
    await vi.advanceTimersByTimeAsync(1_300);
    expect(await settleOnFakeClock(fixture.command(handle.command))).toMatchObject({
      status: "running"
    });
    expect(result).toBeUndefined();
    expect(execution.signal?.aborted).toBe(false);

    execution.complete(successResult({ stdoutPreview: "listed" }));
    await settleOnFakeClock(required(pass));
    await advanceFakeClockUntilSettled(waiting, 250);

    expect(result).toMatchObject({
      status: "settled",
      command: { status: "completed", output: { stdoutPreview: "listed" } }
    });
  });

  it("ends the job of a cancelled command as cancelled when a worker claims it late, and runs nothing", async () => {
    const fixture = await createFixture("late_claim");
    const queued = await fixture.enqueue("ls");
    await db.store.executionWorkspaces.requestWorkspaceCommandCancellation({
      clientInstanceId: fixture.clientInstanceId,
      commandId: queued.id,
      reason: "Workspace command was cancelled with its agent run",
      requestedAt: new Date().toISOString()
    });
    // As the release before this one left it: the command cancelled, its job still queued.
    await db.sql`
      update platform_jobs
      set status = 'queued', finished_at = null, error_code = null, error_message = null
      where client_instance_id = ${fixture.clientInstanceId}`;

    await fixture.worker().runDue();

    expect(fixture.executor.calls).toHaveLength(0);
    expect(await commandJobs(fixture)).toMatchObject([
      { status: "cancelled", attempts: 1, error_code: "WITHDRAWN" }
    ]);
    expect(await fixture.command(queued)).toMatchObject({ status: "cancelled", attempts: 0 });
  });
});
