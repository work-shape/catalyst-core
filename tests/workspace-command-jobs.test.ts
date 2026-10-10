import { mkdir, mkdtemp, readdir, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  StoreBackedAuditRecorder,
  type ClientInstanceId,
  type ExecutionWorkspace,
  type JobWorker,
  type PlatformStores,
  type WorkspaceCommand
} from "@vivd-catalyst/core";
import {
  WORKSPACE_COMMAND_CANCELLATION_CHECK_INTERVAL_MS,
  createLocalWorkspaceFileByteStore,
  createWorkspaceCommandClient,
  createWorkspaceCommandJobs,
  LocalWorkspaceCommandRunner,
  runWorkspaceCommandJob,
  type ProcessResult,
  type WorkspaceCommandJobsOptions,
  type WorkspaceCommandProcessExecutor,
  type WorkspaceCommandProcessInput
} from "@vivd-catalyst/tool-execution";
import { afterEach, describe, expect, it } from "vitest";
import { deferred, required, waitUntil } from "./support/assertions";
import { useJobExecutorHarness } from "./support/job-executor-harness";
import { usePostgresSuite } from "./support/postgres-suite";

const cleanupDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("workspace commands on the job executor", () => {
  const db = usePostgresSuite("command_jobs");
  const harness = useJobExecutorHarness(db);

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
      async () => (await commandLease(queued)).minutes_left > 5,
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

  describe("beside an API and a worker of the previous release", () => {
    it("gives a job to a command the previous release queued without one, once", async () => {
      const fixture = await createFixture("adopt");
      // The previous release's API writes the row and knows nothing of jobs.
      const queued = await db.store.executionWorkspaces.enqueueWorkspaceCommand(
        fixture.request("printf adopted")
      );
      const worker = fixture.worker({}, { schedules: true });

      await worker.runDue();
      expect(await commandJobs(fixture)).toMatchObject([
        { subject: queued.id, status: "queued", concurrency_key: fixture.workspace.id }
      ]);
      // A command with a live job is left alone by the next tick.
      await makeAdoptionDue(fixture);
      const run = worker.runDue();
      (await fixture.executor.next()).complete(successResult({ stdoutPreview: "adopted" }));
      await run;
      // And so is a finished one.
      await makeAdoptionDue(fixture);
      await worker.runDue();

      expect(await commandJobs(fixture)).toMatchObject([{ status: "succeeded", attempts: 1 }]);
      expect(fixture.executor.calls).toHaveLength(1);
      expect(await fixture.command(queued)).toMatchObject({ status: "completed", attempts: 1 });
    });

    it("leaves a command to the previous release's worker that claimed it first", async () => {
      const fixture = await createFixture("yield");
      // Queued by this release, with its job, and claimed by the old worker's queue query.
      const queued = await fixture.enqueue("printf legacy");
      await expect(legacyClaim(fixture, "legacy-lease")).resolves.toBe(queued.id);

      const run = fixture.worker({ yieldCheckIntervalMs: 5 }).runDue();
      await waitUntil(
        async () => (await commandJobs(fixture))[0]?.status === "running",
        "the job waits on the command"
      );
      await db.store.executionWorkspaces.completeWorkspaceCommand({
        clientInstanceId: fixture.clientInstanceId,
        commandId: queued.id,
        leaseToken: "legacy-lease",
        output: { ...commandOutput(), stdoutPreview: "legacy" },
        completedAt: new Date().toISOString()
      });
      await run;

      // One result, the previous release's. The job ends without having started a process.
      expect(fixture.executor.calls).toHaveLength(0);
      expect(await fixture.command(queued)).toMatchObject({
        status: "completed",
        attempts: 1,
        output: { stdoutPreview: "legacy" }
      });
      expect(await commandJobs(fixture)).toMatchObject([{ status: "succeeded", attempts: 1 }]);
    });

    it("fails a command whose previous-release worker was killed, without running it again", async () => {
      const fixture = await createFixture("legacy_killed");
      const queued = await fixture.enqueue("printf half");
      await legacyClaim(fixture, "legacy-lease");
      await db.sql`
        update workspace_commands set lease_expires_at = now() - interval '1 second'
        where id = ${queued.id}`;

      await fixture.worker().runDue();

      expect(fixture.executor.calls).toHaveLength(0);
      expect(await fixture.command(queued)).toMatchObject({
        status: "failed",
        attempts: 2,
        error: { category: "worker_lost" }
      });
      expect(await commandJobs(fixture)).toMatchObject([{ status: "succeeded", attempts: 1 }]);
    });

    it("keeps the previous release's worker off a command the job holds, and a rollback ends it once", async () => {
      const fixture = await createFixture("rollback");
      harness.heartbeatsByHand();
      const queued = await fixture.enqueue("printf held");
      const run = fixture.worker().runDue();
      const execution = await fixture.executor.next();

      // The mirror makes the command look held to the previous release: neither its claim nor
      // its stale-lease recovery touches it.
      await expect(legacyClaim(fixture, "legacy-lease")).resolves.toBeUndefined();
      await expect(legacyRecoverStale(fixture)).resolves.toEqual([]);

      // The rollback: this release's worker is gone mid-command and only the previous release
      // runs. Once the mirrored lease has run out, its recovery fails the command.
      await db.sql`
        update workspace_commands set lease_expires_at = now() - interval '1 second'
        where id = ${queued.id}`;
      await expect(legacyRecoverStale(fixture)).resolves.toEqual([queued.id]);

      // What the lost worker reports afterwards changes nothing.
      execution.complete(successResult({ stdoutPreview: "too late" }));
      await run;
      expect(fixture.executor.calls).toHaveLength(1);
      expect(await fixture.command(queued)).toMatchObject({
        status: "failed",
        attempts: 1,
        error: { code: "WORKSPACE_COMMAND_STALE" }
      });
    });
  });

  interface Fixture {
    clientInstanceId: ClientInstanceId;
    workspace: ExecutionWorkspace;
    commandRootDirectory: string;
    executor: ControlledExecutor;
    client: ReturnType<typeof createWorkspaceCommandClient>;
    request(command: string, workspace?: ExecutionWorkspace): CommandRequest;
    enqueue(
      command: string,
      stores?: Pick<PlatformStores, "executionWorkspaces" | "transaction">,
      workspace?: ExecutionWorkspace
    ): Promise<WorkspaceCommand>;
    command(command: Pick<WorkspaceCommand, "id">): Promise<WorkspaceCommand | undefined>;
    secondWorkspace(): Promise<ExecutionWorkspace>;
    worker(
      options?: Partial<WorkspaceCommandJobsOptions>,
      serve?: { schedules: boolean }
    ): JobWorker;
  }

  type CommandRequest = Parameters<ReturnType<typeof createWorkspaceCommandClient>["enqueue"]>[0];

  async function createFixture(
    label: string,
    input: { realProcesses?: boolean; withAuditRecorder?: boolean } = {}
  ): Promise<Fixture> {
    const clientInstanceId = db.clientInstance(label);
    const owner = await db.store.users.createUser({
      clientInstanceId,
      displayLabel: "Command owner"
    });
    const ownerUserId = owner.id;
    const personalWorkspace = await db.store.workspaces.ensurePersonalWorkspace({
      clientInstanceId,
      userId: owner.id
    });
    const createWorkspace = async (title: string) => {
      const conversation = await db.store.conversations.createConversation({
        visibility: "workspace",
        clientInstanceId,
        collaborationWorkspaceId: personalWorkspace.id,
        createdByUserId: ownerUserId,
        createdByExternalUserId: `external_${ownerUserId}`,
        title,
        retainedUntil: "2099-01-01T00:00:00.000Z"
      });
      return db.store.executionWorkspaces.ensureExecutionWorkspace({
        clientInstanceId,
        conversationId: conversation.id,
        ownerUserId
      });
    };
    const workspace = await createWorkspace("Command jobs");
    const rootDirectory = await mkdtemp(join(tmpdir(), "catalyst-command-jobs-"));
    cleanupDirectories.push(rootDirectory);
    const commandRootDirectory = join(rootDirectory, "commands");
    const executor = new ControlledExecutor();
    const auditRecorder = input.withAuditRecorder
      ? new StoreBackedAuditRecorder({ clientInstanceId, store: db.store.audit })
      : undefined;
    const runner = new LocalWorkspaceCommandRunner({
      store: db.store,
      byteStore: createLocalWorkspaceFileByteStore({
        rootDirectory: join(rootDirectory, "objects")
      }),
      tempRootDirectory: commandRootDirectory,
      ...(input.realProcesses ? {} : { processExecutor: executor }),
      auditRecorder
    });
    const now = () => new Date().toISOString();
    const client = createWorkspaceCommandClient({
      stores: db.store,
      resultPollIntervalMs: 5,
      now
    });
    const request = (command: string, target = workspace): CommandRequest => ({
      clientInstanceId,
      workspaceId: target.id,
      ownerUserId,
      command,
      limits: { timeoutSeconds: 60, idleTimeoutSeconds: 60 }
    });
    return {
      clientInstanceId,
      workspace,
      commandRootDirectory,
      executor,
      client,
      request,
      async enqueue(command, stores = db.store, target = workspace) {
        const queued = await createWorkspaceCommandClient({ stores, now }).enqueue(
          request(command, target)
        );
        return queued.command;
      },
      command: ({ id }) =>
        db.store.executionWorkspaces.getWorkspaceCommand({ clientInstanceId, commandId: id }),
      secondWorkspace: () => createWorkspace("Another workspace"),
      worker(options = {}, serve = { schedules: false }) {
        const jobs = createWorkspaceCommandJobs({
          stores: db.store,
          runner,
          auditRecorder,
          cancellationCheckIntervalMs: 5,
          ...options
        });
        return harness.worker(
          db.store,
          clientInstanceId,
          jobs.handlers,
          serve.schedules ? jobs.schedules : []
        );
      }
    };
  }

  function commandJobs(fixture: Pick<Fixture, "clientInstanceId">) {
    return db.sql<
      {
        status: string;
        attempts: number;
        max_attempts: number;
        subject: string | null;
        concurrency_key: string | null;
        error_code: string | null;
      }[]
    >`
      select status, attempts, max_attempts, subject, concurrency_key, error_code
      from platform_jobs
      where client_instance_id = ${fixture.clientInstanceId}
        and kind = ${runWorkspaceCommandJob.kind}
      order by created_at, id
    `;
  }

  async function commandLease(command: Pick<WorkspaceCommand, "id">) {
    const [row] = await db.sql<{ minutes_left: number }[]>`
      select extract(epoch from lease_expires_at - now())::float8 / 60 as minutes_left
      from workspace_commands where id = ${command.id}`;
    return required(row);
  }

  async function makeAdoptionDue(fixture: Pick<Fixture, "clientInstanceId">): Promise<void> {
    await db.sql`
      update platform_jobs set run_after = now()
      where client_instance_id = ${fixture.clientInstanceId}
        and kind = 'workspace_command.adopt_legacy' and status = 'queued'`;
  }

  /**
   * The claim of the previous release's command worker, as that release ran it: the oldest
   * queued command of an active workspace, whatever job stands beside it.
   */
  async function legacyClaim(
    fixture: Pick<Fixture, "clientInstanceId">,
    leaseToken: string
  ): Promise<string | undefined> {
    const rows = await db.sql<{ id: string }[]>`
      with candidate as (
        select wc.id
        from workspace_commands wc
        join execution_workspaces ew on ew.id = wc.workspace_id
        where wc.client_instance_id = ${fixture.clientInstanceId}
          and wc.status = 'queued'
          and ew.status = 'active'
        order by wc.queued_at asc, wc.id asc
        limit 1
        for update skip locked
      )
      update workspace_commands wc
      set status = 'running',
          lease_owner = 'legacy-worker',
          lease_token = ${leaseToken},
          lease_expires_at = now() + interval '10 minutes',
          heartbeat_at = now(),
          started_at = coalesce(wc.started_at, now()),
          attempts = wc.attempts + 1,
          error = null,
          updated_at = now()
      from candidate
      where wc.id = candidate.id
      returning wc.id
    `;
    return rows[0]?.id;
  }

  /** The previous release's stale-lease recovery: a command whose lease ran out is failed. */
  async function legacyRecoverStale(fixture: Pick<Fixture, "clientInstanceId">): Promise<string[]> {
    const rows = await db.sql<{ id: string }[]>`
      update workspace_commands
      set status = 'failed',
          error = ${db.sql.json({
            code: "WORKSPACE_COMMAND_STALE",
            message: "Workspace command lease expired before the worker completed it",
            category: "stale_lease"
          })},
          lease_owner = null, lease_token = null, lease_expires_at = null, heartbeat_at = null,
          completed_at = now(), updated_at = now()
      where client_instance_id = ${fixture.clientInstanceId}
        and status in ('running', 'cancelling')
        and lease_expires_at is not null
        and lease_expires_at < now()
      returning id
    `;
    return rows.map((row) => row.id);
  }
});

interface Execution extends WorkspaceCommandProcessInput {
  complete(result: ProcessResult): void;
}

/** A process executor the test ends by hand. An aborted signal ends it as a cancelled process. */
class ControlledExecutor implements WorkspaceCommandProcessExecutor {
  readonly calls: Execution[] = [];
  private taken = 0;
  private waiting: Array<() => void> = [];

  execute(input: WorkspaceCommandProcessInput): Promise<ProcessResult> {
    const result = deferred<ProcessResult>();
    this.calls.push({ ...input, complete: result.resolve });
    for (const wake of this.waiting.splice(0)) wake();
    input.signal?.addEventListener(
      "abort",
      () =>
        result.resolve({
          ...successResult(),
          exitCode: 130,
          cancelled: true,
          cancellationReason:
            typeof input.signal?.reason === "string" ? input.signal.reason : undefined
        }),
      { once: true }
    );
    return result.promise;
  }

  /** The next execution that started, in the order they started. */
  async next(): Promise<Execution> {
    while (this.calls.length <= this.taken)
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    return required(this.calls[this.taken++]);
  }
}

function successResult(input: Partial<ProcessResult> = {}): ProcessResult {
  return {
    exitCode: 0,
    stdoutPreview: "",
    stderrPreview: "",
    durationMs: 10,
    truncated: { stdout: false, stderr: false },
    ...input
  };
}

function commandOutput(): NonNullable<WorkspaceCommand["output"]> {
  return {
    exitCode: 0,
    stdoutPreview: "",
    stderrPreview: "",
    durationMs: 10,
    truncated: { stdout: false, stderr: false },
    changedFiles: [],
    promotedArtifacts: []
  };
}
