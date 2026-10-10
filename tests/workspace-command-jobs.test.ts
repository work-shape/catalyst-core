import { mkdir, readdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import type { PlatformStores, WorkspaceCommand } from "@vivd-catalyst/core";
import {
  WORKSPACE_COMMAND_CANCELLATION_CHECK_INTERVAL_MS,
  WORKSPACE_COMMAND_HEARTBEAT_MS,
  WORKSPACE_COMMAND_LEASE_MS
} from "@vivd-catalyst/tool-execution";
import { describe, expect, it } from "vitest";
import { required, waitUntil } from "./support/assertions";
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
    const withoutJobs: Pick<PlatformStores, "executionWorkspaces" | "transaction"> = {
      executionWorkspaces: db.store.executionWorkspaces,
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
    const handle = await fixture.client.enqueue(fixture.request("sleep 60"));
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
    const handle = await fixture.client.enqueue(fixture.request("sleep 60"));
    const stopped = new AbortController();
    stopped.abort();

    await expect(fixture.client.await(handle, { signal: stopped.signal })).resolves.toMatchObject({
      status: "cancelled",
      command: { status: "cancelled" }
    });
    await fixture.worker().runDue();

    expect(fixture.executor.calls).toHaveLength(0);
    expect(await commandJobs(fixture)).toMatchObject([{ status: "succeeded", attempts: 1 }]);
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
    (await fixture.executor.next()).complete(successResult());
    await secondPass;

    expect(fixture.executor.calls.map((call) => call.command.command)).toEqual([
      ...started.map((execution) => execution.command.command),
      "second"
    ]);
    const [ranFirst, ranSecond] = [await fixture.command(first), await fixture.command(second)];
    expect(required(ranSecond?.startedAt) >= required(ranFirst?.completedAt)).toBe(true);
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
    const handle = await fixture.client.enqueue(fixture.request("printf done"));
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
