import { randomUUID } from "node:crypto";
import {
  AppError,
  JobLeaseLostError,
  StoreBackedAuditRecorder,
  asWorkspaceCommandId,
  claimSubjectRow,
  defineJobHandler,
  defineSchedule,
  subjectRowLeaseOwnerId,
  type AuditRecorder,
  type Job,
  type JobControl,
  type JobSchedule,
  type PlatformStores,
  type RegisteredJobHandler,
  type WorkspaceCommand,
  type WorkspaceCommandError
} from "@vivd-catalyst/core";
import {
  WORKSPACE_COMMAND_CANCELLATION_CHECK_INTERVAL_MS,
  WORKSPACE_COMMAND_LEASE_MS,
  adoptWorkspaceCommandsJob,
  adoptWorkspaceCommandsSchedule,
  cleanWorkspaceCommandTempStateJob,
  runWorkspaceCommandJob,
  workspaceCommandJobOptions
} from "./workspace-command-kind";
import type { LocalWorkspaceCommandRunner } from "./workspace-command-runner";
import {
  emitWorkspaceCommandTelemetry,
  recordWorkspaceCommandLifecycleAudit,
  workspaceCommandCountsMetadata,
  workspaceCommandTelemetryEvent,
  type WorkspaceCommandTelemetry
} from "./workspace-command-telemetry";

const DEFAULT_TEMP_STATE_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_HYDRATED_WORKSPACE_IDLE_TTL_MS = 60 * 60 * 1000;
// Commands one tick of the adopt schedule gives a job. The next tick takes the rest.
const LEGACY_ADOPTION_BATCH_SIZE = 500;
// The lease a dead job writes onto its command for the moment in which it marks it failed.
const LOST_COMMAND_LEASE_MS = 60 * 1000;
const WORKER_STOPPING_REASON = "Workspace command worker is stopping";
const LEASE_LOST_REASON = "Workspace command lost its job lease";

export interface WorkspaceCommandJobsOptions {
  /** The stores of the process. Reads go through them, writes through the job's transaction. */
  stores: Pick<PlatformStores, "executionWorkspaces">;
  runner: LocalWorkspaceCommandRunner;
  /** How many commands this process runs at once. */
  slots?: number;
  /** Names this process in the audit events and telemetry of its commands. */
  workerId?: string;
  tempStateCleanupIntervalMs?: number;
  hydratedWorkspaceIdleTtlMs?: number;
  auditRecorder?: AuditRecorder;
  telemetry?: WorkspaceCommandTelemetry;
  now?: () => string;
  /** Replaces the second between two looks for a cancellation request. For tests. */
  cancellationCheckIntervalMs?: number;
  /** Replaces the five seconds between two looks at a row another worker holds. For tests. */
  yieldCheckIntervalMs?: number;
}

/** The job kinds the command worker serves, with their schedules. */
export interface WorkspaceCommandJobs {
  handlers: RegisteredJobHandler[];
  schedules: JobSchedule[];
}

type CommandJob = Job<{ commandId: string }>;

/**
 * The command worker's side of the job executor. `workspace.command` takes its row by id, runs
 * the command and writes the row's final state inside the job's fenced transaction. The
 * executor claims, renews and recovers the lease; this module only looks for a cancellation
 * request on the row while the command runs.
 */
export function createWorkspaceCommandJobs(
  options: WorkspaceCommandJobsOptions
): WorkspaceCommandJobs {
  const commands = new WorkspaceCommandJobRun(options);
  return {
    handlers: [
      defineJobHandler({
        kind: runWorkspaceCommandJob,
        slots: options.slots ?? 1,
        run: (job, control) => commands.run(job, control),
        // Transition release: the lease is copied onto the row for workers of the previous release.
        async onHeartbeat(job, lease, stores) {
          await stores.executionWorkspaces.renewClaimedWorkspaceCommandLease({
            clientInstanceId: job.clientInstanceId,
            commandId: asWorkspaceCommandId(job.payload.commandId),
            leaseToken: lease.leaseToken,
            leaseMs: WORKSPACE_COMMAND_LEASE_MS
          });
        },
        onExhausted: (job, stores) => commands.failAfterWorkerLoss(job, stores)
      }),
      defineJobHandler({
        kind: adoptWorkspaceCommandsJob,
        slots: 1,
        async run(job, control) {
          // An enqueue under a live dedupe key inserts nothing, so a tick may run twice.
          const adopted = await control.transaction(async (stores) => {
            const waiting = await stores.executionWorkspaces.listWorkspaceCommandsWithoutJob({
              clientInstanceId: job.clientInstanceId,
              jobKind: runWorkspaceCommandJob.kind,
              limit: LEGACY_ADOPTION_BATCH_SIZE
            });
            for (const command of waiting)
              await stores.jobs.enqueue(
                runWorkspaceCommandJob,
                { commandId: command.id },
                { clientInstanceId: job.clientInstanceId, ...workspaceCommandJobOptions(command) }
              );
            return waiting.length;
          });
          if (adopted > 0) control.logger.info({ adopted }, "Adopted commands without a job");
        }
      }),
      defineJobHandler({
        kind: cleanWorkspaceCommandTempStateJob,
        slots: 1,
        run: (job) => commands.cleanTempState(job)
      })
    ],
    schedules: [
      adoptWorkspaceCommandsSchedule,
      defineSchedule({
        kind: cleanWorkspaceCommandTempStateJob,
        every: options.tempStateCleanupIntervalMs ?? DEFAULT_TEMP_STATE_CLEANUP_INTERVAL_MS
      })
    ]
  };
}

class WorkspaceCommandJobRun {
  private readonly stores: Pick<PlatformStores, "executionWorkspaces">;
  private readonly runner: LocalWorkspaceCommandRunner;
  private readonly workerId: string;
  private readonly hydratedWorkspaceIdleTtlMs: number;
  private readonly auditRecorder?: AuditRecorder;
  private readonly telemetry?: WorkspaceCommandTelemetry;
  private readonly now: () => string;
  private readonly cancellationCheckIntervalMs: number;
  private readonly yieldCheckIntervalMs?: number;

  constructor(options: WorkspaceCommandJobsOptions) {
    this.stores = options.stores;
    this.runner = options.runner;
    this.workerId = options.workerId ?? `workspace-command-worker-${randomUUID()}`;
    this.hydratedWorkspaceIdleTtlMs =
      options.hydratedWorkspaceIdleTtlMs ?? DEFAULT_HYDRATED_WORKSPACE_IDLE_TTL_MS;
    this.auditRecorder = options.auditRecorder;
    this.telemetry = options.telemetry;
    this.now = options.now ?? (() => new Date().toISOString());
    this.cancellationCheckIntervalMs =
      options.cancellationCheckIntervalMs ?? WORKSPACE_COMMAND_CANCELLATION_CHECK_INTERVAL_MS;
    this.yieldCheckIntervalMs = options.yieldCheckIntervalMs;
  }

  async run(job: CommandJob, control: JobControl): Promise<void> {
    // Yield: a row a worker of the previous release holds is left to it until its lease ends.
    const command = await claimSubjectRow(
      control,
      (stores) =>
        stores.executionWorkspaces.claimWorkspaceCommand({
          clientInstanceId: job.clientInstanceId,
          commandId: asWorkspaceCommandId(job.payload.commandId),
          leaseOwnerId: subjectRowLeaseOwnerId(job.id),
          leaseToken: control.leaseToken,
          leaseMs: WORKSPACE_COMMAND_LEASE_MS
        }),
      this.yieldCheckIntervalMs
    );
    if (!command) return;
    try {
      if (command.attempts > 1) {
        // It ran before and whoever ran it is gone. A command is never run a second time.
        await control.transaction((stores) => this.failLostCommand(command, stores));
        return;
      }
      await this.recordRunningCommand(command);
      await this.runUntilEnded(command, control);
    } catch (error: unknown) {
      // The store refuses a row that this attempt no longer holds: a worker of the previous
      // release ended it. That is no failure of the job.
      if (isRowConflict(error)) return;
      throw error;
    }
  }

  /**
   * The worker that ran the command is gone: its lease expired, or its attempt failed before
   * the command's result was written. Runs in the transaction that marks the job dead. The
   * command fails with it unless it is finished or a worker of the previous release holds it.
   */
  async failAfterWorkerLoss(job: CommandJob, stores: PlatformStores): Promise<void> {
    const claim = await stores.executionWorkspaces.claimWorkspaceCommand({
      clientInstanceId: job.clientInstanceId,
      commandId: asWorkspaceCommandId(job.payload.commandId),
      leaseOwnerId: subjectRowLeaseOwnerId(job.id),
      leaseToken: randomUUID(),
      leaseMs: LOST_COMMAND_LEASE_MS
    });
    if (claim.status === "claimed") await this.failLostCommand(claim.row, stores);
  }

  async cleanTempState(job: Job): Promise<void> {
    const result = await this.runner.cleanupIdleWorkspaceDirectories({
      olderThanMs: this.hydratedWorkspaceIdleTtlMs
    });
    if (result.removedCount > 0 || result.failedCount > 0) {
      await emitWorkspaceCommandTelemetry(this.telemetry, {
        type: "temp_state_cleaned",
        clientInstanceId: job.clientInstanceId,
        workerId: this.workerId,
        removedCount: result.removedCount,
        failedCount: result.failedCount,
        activeCounts: await this.readActiveCounts(job.clientInstanceId)
      });
    }
  }

  /**
   * Runs the command to its recorded end. The runner's signal is aborted when a cancellation
   * request shows on the row, when the worker stops and when the job's lease is lost; the
   * process group ends with it.
   */
  private async runUntilEnded(command: WorkspaceCommand, control: JobControl): Promise<void> {
    const abort = new AbortController();
    const watch = new AbortController();
    const onJobAborted = () => {
      abort.abort(
        control.signal.reason instanceof JobLeaseLostError
          ? LEASE_LOST_REASON
          : WORKER_STOPPING_REASON
      );
    };
    if (control.signal.aborted) onJobAborted();
    control.signal.addEventListener("abort", onJobAborted, { once: true });
    const watching = this.watchForCancellation(command, abort, watch.signal);
    try {
      await this.runner.runClaimedCommand(command, {
        signal: abort.signal,
        transaction: control.transaction
      });
    } finally {
      control.signal.removeEventListener("abort", onJobAborted);
      watch.abort();
      await watching;
    }
  }

  /** Looks at the row every second until the command ended or a cancellation was requested. */
  private async watchForCancellation(
    command: WorkspaceCommand,
    abort: AbortController,
    ended: AbortSignal
  ): Promise<void> {
    while (!(await waitUnlessEnded(this.cancellationCheckIntervalMs, ended))) {
      let latest: WorkspaceCommand | undefined;
      try {
        latest = await this.stores.executionWorkspaces.getWorkspaceCommand({
          clientInstanceId: command.clientInstanceId,
          commandId: command.id
        });
      } catch {
        // A read that failed is tried again at the next look.
        continue;
      }
      if (latest?.status === "cancelling") {
        abort.abort(latest.cancellationReason ?? "Workspace command was cancelled");
        return;
      }
    }
  }

  /** Fails a command this transaction claimed, with its audit event in the same transaction. */
  private async failLostCommand(command: WorkspaceCommand, stores: PlatformStores): Promise<void> {
    if (!command.leaseToken)
      throw new AppError("INTERNAL", "Workspace command must have a lease token after claim");
    const failed = await stores.executionWorkspaces.failWorkspaceCommand({
      clientInstanceId: command.clientInstanceId,
      commandId: command.id,
      leaseToken: command.leaseToken,
      error: workerLostError(),
      failedAt: this.now()
    });
    if (this.auditRecorder)
      await recordWorkspaceCommandLifecycleAudit({
        auditRecorder: new StoreBackedAuditRecorder({
          clientInstanceId: command.clientInstanceId,
          store: stores.audit
        }),
        type: "workspace_command.recovered_stale",
        status: "failed",
        command: failed,
        metadata: {
          workerId: this.workerId,
          errorCode: workerLostError().code,
          errorCategory: workerLostError().category
        }
      });
    await emitWorkspaceCommandTelemetry(
      this.telemetry,
      workspaceCommandTelemetryEvent("stale_recovered", failed, { workerId: this.workerId })
    );
  }

  private async recordRunningCommand(command: WorkspaceCommand): Promise<void> {
    const activeCounts = await this.readActiveCounts(command.clientInstanceId);
    await recordWorkspaceCommandLifecycleAudit({
      auditRecorder: this.auditRecorder,
      type: "workspace_command.running",
      status: "success",
      command,
      metadata: {
        workerId: this.workerId,
        leaseExpiresAt: command.leaseExpiresAt ?? null,
        ...(activeCounts ? { activeCounts: workspaceCommandCountsMetadata(activeCounts) } : {})
      }
    });
    await emitWorkspaceCommandTelemetry(
      this.telemetry,
      workspaceCommandTelemetryEvent("running", command, {
        workerId: this.workerId,
        activeCounts
      })
    );
  }

  private async readActiveCounts(clientInstanceId: WorkspaceCommand["clientInstanceId"]) {
    try {
      return await this.stores.executionWorkspaces.countActiveWorkspaceCommands({
        clientInstanceId
      });
    } catch {
      return undefined;
    }
  }
}

function workerLostError(): WorkspaceCommandError {
  return {
    code: "WORKSPACE_COMMAND_WORKER_LOST",
    message: "The worker that ran the workspace command was lost before the command finished",
    category: "worker_lost"
  };
}

/** A conflict the command store raised about the row, not the executor about the job's lease. */
function isRowConflict(error: unknown): boolean {
  return (
    error instanceof AppError && error.code === "CONFLICT" && !(error instanceof JobLeaseLostError)
  );
}

/** Resolves true when `ended` aborts before the time is over, false when the time is over. */
function waitUnlessEnded(milliseconds: number, ended: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (ended.aborted) {
      resolve(true);
      return;
    }
    const onEnded = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      ended.removeEventListener("abort", onEnded);
      resolve(false);
    }, milliseconds);
    ended.addEventListener("abort", onEnded, { once: true });
  });
}
