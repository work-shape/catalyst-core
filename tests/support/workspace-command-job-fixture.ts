import { mkdtemp, rm } from "node:fs/promises";
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
  createWorkspaceCommandClient,
  createWorkspaceCommandJobs,
  LocalWorkspaceCommandRunner,
  runWorkspaceCommandJob,
  type ProcessResult,
  type WorkspaceCommandJobsOptions,
  type WorkspaceCommandProcessExecutor,
  type WorkspaceCommandProcessInput
} from "@vivd-catalyst/tool-execution";
import { createFilesystemObjectStorage } from "@vivd-catalyst/object-storage";
import { afterEach } from "vitest";
import { deferred, required } from "./assertions";
import type { useJobExecutorHarness } from "./job-executor-harness";
import type { PostgresSuite } from "./postgres-suite";

/**
 * One client instance with a workspace, the command client and command workers on the job
 * executor. The process executor is ended by hand unless the fixture asks for real processes.
 */
export function useWorkspaceCommandJobFixture(
  db: PostgresSuite,
  harness: ReturnType<typeof useJobExecutorHarness>
) {
  const cleanupDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true }))
    );
  });

  async function createFixture(
    label: string,
    input: { realProcesses?: boolean; withAuditRecorder?: boolean } = {}
  ): Promise<WorkspaceCommandJobFixture> {
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
      byteStore: createFilesystemObjectStorage(join(rootDirectory, "objects")),
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

  function commandJobs(fixture: Pick<WorkspaceCommandJobFixture, "clientInstanceId">) {
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

  return { createFixture, commandJobs };
}

export interface WorkspaceCommandJobFixture {
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
  worker(options?: Partial<WorkspaceCommandJobsOptions>, serve?: { schedules: boolean }): JobWorker;
}

type CommandRequest = Parameters<ReturnType<typeof createWorkspaceCommandClient>["enqueue"]>[0];

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

export function successResult(input: Partial<ProcessResult> = {}): ProcessResult {
  return {
    exitCode: 0,
    stdoutPreview: "",
    stderrPreview: "",
    durationMs: 10,
    truncated: { stdout: false, stderr: false },
    ...input
  };
}
