import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  asClientInstanceId,
  type ClientInstanceId,
  type Conversation,
  type WorkspaceCommand,
  type WorkspaceCommandLimits
} from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";
import {
  createLocalWorkspaceFileByteStore,
  LocalWorkspaceCommandRunner,
  WorkspaceCommandWorker,
  type ProcessResult,
  type WorkspaceCommandProcessExecutor,
  type WorkspaceCommandProcessInput
} from "@vivd-catalyst/tool-execution";

const cleanupDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
  cleanupDirectories.length = 0;
});

describe("workspace command worker", () => {
  it("claims commands and heartbeats the active lease while execution is running", async () => {
    const harness = await createWorkerHarness();
    const queued = await harness.enqueue("sleep 60");

    const run = harness.worker.runOnce({ recoverStale: false });
    await harness.executor.started;
    const heartbeated = await waitForCommand(harness, queued.id, (command) =>
      command.heartbeatAt !== undefined &&
      command.startedAt !== undefined &&
      command.heartbeatAt > command.startedAt
        ? command
        : undefined
    );

    expect(heartbeated).toMatchObject({
      status: "running",
      leaseOwner: "worker-test",
      attempts: 1
    });
    harness.executor.complete(successProcessResult({ stdoutPreview: "done" }));

    await expect(run).resolves.toMatchObject({
      status: "claimed",
      command: {
        status: "completed",
        output: {
          stdoutPreview: "done"
        }
      }
    });
  });

  it("observes cancellation requests, aborts execution, and marks the claimed command cancelled", async () => {
    const harness = await createWorkerHarness();
    const queued = await harness.enqueue("sleep 60");

    const run = harness.worker.runOnce({ recoverStale: false });
    await harness.executor.started;
    await harness.store.requestWorkspaceCommandCancellation({
      clientInstanceId: harness.clientInstanceId,
      commandId: queued.id,
      reason: "user stopped it",
      requestedAt: "2026-06-29T10:05:00.000Z"
    });

    const result = await run;

    expect(result).toMatchObject({
      status: "claimed",
      command: {
        status: "cancelled",
        cancellationReason: "user stopped it",
        output: {
          exitCode: 130
        }
      }
    });
  });

  it("recovers stale claimed commands as failed before claiming new work", async () => {
    const harness = await createWorkerHarness();
    const stale = await harness.enqueue("sleep 60");
    const claimed = await harness.store.claimNextWorkspaceCommand({
      clientInstanceId: harness.clientInstanceId,
      workerId: "stale-worker",
      leaseToken: "stale-lease",
      now: "2026-06-29T09:58:00.000Z",
      leaseExpiresAt: "2026-06-29T09:59:00.000Z"
    });
    expect(claimed?.id).toBe(stale.id);

    const recovered = await harness.worker.recoverStaleCommands();

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      id: stale.id,
      status: "failed",
      error: {
        code: "WORKSPACE_COMMAND_STALE",
        category: "stale_lease"
      },
      leaseToken: undefined
    });
  });

  it("stops gracefully by finishing the active command and not claiming more work", async () => {
    const harness = await createWorkerHarness({
      pollIntervalMs: 5
    });
    const queued = await harness.enqueue("sleep 60");
    const loop = harness.worker.start();
    await harness.executor.started;

    let stopped = false;
    const stop = harness.worker.stop().then(() => {
      stopped = true;
    });
    await sleep(20);
    expect(stopped).toBe(false);

    harness.executor.complete(successProcessResult({ stdoutPreview: "finished" }));
    await stop;
    await loop;

    await expect(
      harness.store.getWorkspaceCommand({
        clientInstanceId: harness.clientInstanceId,
        commandId: queued.id
      })
    ).resolves.toMatchObject({
      status: "completed",
      output: {
        stdoutPreview: "finished"
      }
    });
  });

  it("cancels active execution promptly when stop requests active cancellation", async () => {
    const harness = await createWorkerHarness({
      pollIntervalMs: 5
    });
    const queued = await harness.enqueue("sleep 60");
    const loop = harness.worker.start();
    await harness.executor.started;

    const stop = harness.worker.stop({
      cancelActive: true,
      reason: "Received SIGTERM"
    });

    const stopResult = Promise.race([
      stop.then(() => "stopped"),
      sleep(100).then(() => "timeout")
    ]);
    await expect(stopResult).resolves.toBe("stopped");
    await loop;

    await expect(
      harness.store.getWorkspaceCommand({
        clientInstanceId: harness.clientInstanceId,
        commandId: queued.id
      })
    ).resolves.toMatchObject({
      status: "cancelled",
      cancellationReason: "Received SIGTERM",
      output: {
        exitCode: 130
      }
    });
  });
});

async function createWorkerHarness(input: { pollIntervalMs?: number } = {}) {
  const clientInstanceId = asClientInstanceId(`worker_${globalThis.crypto.randomUUID()}`);
  const ownerUserId = "user-1";
  const store = new InMemoryPlatformStore();
  const conversation = await store.createConversation({
    clientInstanceId,
    ownerUserId,
    ownerExternalUserId: ownerUserId,
    title: "Worker test",
    retainedUntil: "2026-07-29T00:00:00.000Z"
  });
  const rootDirectory = await mkdtemp(join(tmpdir(), "catalyst-worker-test-"));
  cleanupDirectories.push(rootDirectory);
  const byteStore = createLocalWorkspaceFileByteStore({
    rootDirectory: join(rootDirectory, "objects")
  });
  const executor = new ControlledWorkspaceCommandExecutor();
  const runner = new LocalWorkspaceCommandRunner({
    store,
    byteStore,
    tempRootDirectory: join(rootDirectory, "commands"),
    processExecutor: executor
  });
  let clock = 0;
  const worker = new WorkspaceCommandWorker({
    clientInstanceId,
    store,
    runner,
    workerId: "worker-test",
    pollIntervalMs: input.pollIntervalMs ?? 20,
    heartbeatIntervalMs: 5,
    cancellationPollIntervalMs: 5,
    staleRecoveryIntervalMs: 1000,
    leaseDurationMs: 1000,
    now: () => new Date(Date.UTC(2026, 5, 29, 10, 0, clock++)).toISOString()
  });
  const workspace = await store.ensureExecutionWorkspace({
    clientInstanceId,
    conversationId: conversation.id,
    ownerUserId,
    now: "2026-06-29T10:00:00.000Z"
  });
  return {
    clientInstanceId,
    ownerUserId,
    store,
    conversation,
    workspace,
    executor,
    worker,
    enqueue(command: string, limits: Partial<WorkspaceCommandLimits> = {}) {
      return store.enqueueWorkspaceCommand({
        clientInstanceId,
        workspaceId: workspace.id,
        ownerUserId,
        command,
        limits: {
          timeoutSeconds: 60,
          idleTimeoutSeconds: 30,
          maxStdoutBytes: 64 * 1024,
          maxStderrBytes: 64 * 1024,
          maxWorkspaceBytes: 100 * 1024 * 1024,
          ...limits
        },
        queuedAt: "2026-06-29T09:59:59.000Z"
      });
    }
  };
}

class ControlledWorkspaceCommandExecutor implements WorkspaceCommandProcessExecutor {
  private readonly startedDeferred = deferred<WorkspaceCommandProcessInput>();
  private resolveResult?: (result: ProcessResult) => void;
  readonly started = this.startedDeferred.promise;

  execute(input: WorkspaceCommandProcessInput): Promise<ProcessResult> {
    this.startedDeferred.resolve(input);
    return new Promise((resolve) => {
      this.resolveResult = resolve;
      input.signal?.addEventListener(
        "abort",
        () => {
          resolve({
            exitCode: 130,
            stdoutPreview: "",
            stderrPreview: "",
            durationMs: 10,
            truncated: {
              stdout: false,
              stderr: false
            },
            cancelled: true,
            cancellationReason:
              typeof input.signal?.reason === "string" ? input.signal.reason : undefined
          });
        },
        { once: true }
      );
    });
  }

  complete(result: ProcessResult): void {
    this.resolveResult?.(result);
  }
}

function successProcessResult(input: Partial<ProcessResult> = {}): ProcessResult {
  return {
    exitCode: 0,
    stdoutPreview: "",
    stderrPreview: "",
    durationMs: 10,
    truncated: {
      stdout: false,
      stderr: false
    },
    ...input
  };
}

async function waitForCommand(
  harness: {
    clientInstanceId: ClientInstanceId;
    store: InMemoryPlatformStore;
  },
  commandId: WorkspaceCommand["id"],
  predicate: (command: WorkspaceCommand) => WorkspaceCommand | undefined
): Promise<WorkspaceCommand> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const command = await harness.store.getWorkspaceCommand({
      clientInstanceId: harness.clientInstanceId,
      commandId
    });
    if (command) {
      const result = predicate(command);
      if (result) {
        return result;
      }
    }
    await sleep(5);
  }
  throw new Error("Timed out waiting for workspace command state");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
