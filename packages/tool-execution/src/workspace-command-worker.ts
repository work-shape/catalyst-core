import { randomUUID } from "node:crypto";
import type {
  AuditRecorder,
  ClientInstanceId,
  PlatformStore,
  WorkspaceCommand,
  WorkspaceCommandError
} from "@vivd-catalyst/core";
import { LocalWorkspaceCommandRunner } from "./workspace-command-runner";
import {
  emitWorkspaceCommandTelemetry,
  recordWorkspaceCommandLifecycleAudit,
  workspaceCommandCountsMetadata,
  workspaceCommandTelemetryEvent,
  type WorkspaceCommandTelemetry
} from "./workspace-command-telemetry";

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_LEASE_DURATION_MS = 10 * 60 * 1000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;
const DEFAULT_CANCELLATION_POLL_INTERVAL_MS = 1000;
const DEFAULT_STALE_RECOVERY_INTERVAL_MS = 30000;
const DEFAULT_STALE_RECOVERY_LIMIT = 50;
const DEFAULT_TEMP_STATE_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_ORPHANED_TEMP_STATE_MAX_AGE_MS = 60 * 60 * 1000;

export type WorkspaceCommandWorkerStore = Pick<
  PlatformStore,
  | "claimNextWorkspaceCommand"
  | "countActiveWorkspaceCommands"
  | "getWorkspaceCommand"
  | "heartbeatWorkspaceCommand"
  | "recoverStaleWorkspaceCommands"
>;

export interface WorkspaceCommandWorkerOptions {
  clientInstanceId: ClientInstanceId;
  store: WorkspaceCommandWorkerStore;
  runner: LocalWorkspaceCommandRunner;
  workerId?: string;
  concurrency?: number;
  pollIntervalMs?: number;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  cancellationPollIntervalMs?: number;
  staleRecoveryIntervalMs?: number;
  staleRecoveryLimit?: number;
  tempStateCleanupIntervalMs?: number;
  orphanedTempStateMaxAgeMs?: number;
  auditRecorder?: AuditRecorder;
  telemetry?: WorkspaceCommandTelemetry;
  now?: () => string;
}

export interface WorkspaceCommandWorkerRunOnceResult {
  status: "claimed" | "idle";
  command?: WorkspaceCommand;
}

export class WorkspaceCommandWorker {
  private readonly clientInstanceId: ClientInstanceId;
  private readonly store: WorkspaceCommandWorkerStore;
  private readonly runner: LocalWorkspaceCommandRunner;
  private readonly workerId: string;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly leaseDurationMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly cancellationPollIntervalMs: number;
  private readonly staleRecoveryIntervalMs: number;
  private readonly staleRecoveryLimit: number;
  private readonly tempStateCleanupIntervalMs: number;
  private readonly orphanedTempStateMaxAgeMs: number;
  private readonly auditRecorder?: AuditRecorder;
  private readonly telemetry?: WorkspaceCommandTelemetry;
  private readonly now: () => string;
  private readonly activeControllers = new Set<AbortController>();
  private stopping = false;
  private loopPromise?: Promise<void>;
  private lastStaleRecoveryMs = 0;
  private lastTempStateCleanupMs = 0;

  constructor(options: WorkspaceCommandWorkerOptions) {
    this.clientInstanceId = options.clientInstanceId;
    this.store = options.store;
    this.runner = options.runner;
    this.workerId = options.workerId ?? `workspace-command-worker-${randomUUID()}`;
    this.concurrency = options.concurrency ?? 1;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.cancellationPollIntervalMs =
      options.cancellationPollIntervalMs ?? DEFAULT_CANCELLATION_POLL_INTERVAL_MS;
    this.staleRecoveryIntervalMs =
      options.staleRecoveryIntervalMs ?? DEFAULT_STALE_RECOVERY_INTERVAL_MS;
    this.staleRecoveryLimit = options.staleRecoveryLimit ?? DEFAULT_STALE_RECOVERY_LIMIT;
    this.tempStateCleanupIntervalMs =
      options.tempStateCleanupIntervalMs ?? DEFAULT_TEMP_STATE_CLEANUP_INTERVAL_MS;
    this.orphanedTempStateMaxAgeMs =
      options.orphanedTempStateMaxAgeMs ?? DEFAULT_ORPHANED_TEMP_STATE_MAX_AGE_MS;
    this.auditRecorder = options.auditRecorder;
    this.telemetry = options.telemetry;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async runOnce(input: { recoverStale?: boolean } = {}): Promise<WorkspaceCommandWorkerRunOnceResult> {
    if (input.recoverStale ?? true) {
      await this.recoverStaleCommands();
    }
    await this.maybeCleanupOrphanedTempState();
    const now = this.now();
    const claimed = await this.store.claimNextWorkspaceCommand({
      clientInstanceId: this.clientInstanceId,
      workerId: this.workerId,
      leaseToken: randomUUID(),
      now,
      leaseExpiresAt: addMilliseconds(now, this.leaseDurationMs)
    });
    if (!claimed) {
      return { status: "idle" };
    }
    await this.recordRunningCommand(claimed);
    const command = await this.runClaimedCommand(claimed);
    return {
      status: "claimed",
      command
    };
  }

  async recoverStaleCommands(): Promise<WorkspaceCommand[]> {
    const now = this.now();
    this.lastStaleRecoveryMs = Date.now();
    const recovered = await this.store.recoverStaleWorkspaceCommands({
      clientInstanceId: this.clientInstanceId,
      staleLeaseExpiredBefore: now,
      recoveredAt: now,
      error: staleCommandError(),
      limit: this.staleRecoveryLimit
    });
    for (const command of recovered) {
      await recordWorkspaceCommandLifecycleAudit({
        auditRecorder: this.auditRecorder,
        type: "workspace_command.recovered_stale",
        status: "failed",
        command,
        metadata: {
          workerId: this.workerId,
          ...(command.error?.code ? { errorCode: command.error.code } : {}),
          ...(command.error?.category ? { errorCategory: command.error.category } : {})
        }
      });
      await emitWorkspaceCommandTelemetry(
        this.telemetry,
        workspaceCommandTelemetryEvent("stale_recovered", command, {
          workerId: this.workerId,
          activeCounts: await this.readActiveCounts()
        })
      );
    }
    return recovered;
  }

  start(): Promise<void> {
    if (!this.loopPromise) {
      this.stopping = false;
      this.loopPromise = Promise.all(
        Array.from({ length: this.concurrency }, (_, index) => this.runLoop(index))
      ).then(() => undefined);
    }
    return this.loopPromise;
  }

  runUntilStopped(): Promise<void> {
    return this.start();
  }

  async stop(input: { cancelActive?: boolean; reason?: string } = {}): Promise<void> {
    this.stopping = true;
    if (input.cancelActive) {
      for (const controller of this.activeControllers) {
        controller.abort(input.reason ?? "Workspace command worker is stopping");
      }
    }
    await this.loopPromise;
    this.loopPromise = undefined;
  }

  private async runLoop(index: number): Promise<void> {
    while (!this.stopping) {
      await this.maybeRecoverStaleCommands();
      await this.maybeCleanupOrphanedTempState();
      const result = await this.runOnce({ recoverStale: false });
      if (result.status === "idle") {
        await sleep(this.pollIntervalMs);
      }
    }
    void index;
  }

  private async maybeRecoverStaleCommands(): Promise<void> {
    if (Date.now() - this.lastStaleRecoveryMs < this.staleRecoveryIntervalMs) {
      return;
    }
    await this.recoverStaleCommands();
  }

  private async maybeCleanupOrphanedTempState(): Promise<void> {
    if (Date.now() - this.lastTempStateCleanupMs < this.tempStateCleanupIntervalMs) {
      return;
    }
    this.lastTempStateCleanupMs = Date.now();
    const result = await this.runner.cleanupOrphanedTempState({
      olderThanMs: this.orphanedTempStateMaxAgeMs
    });
    if (result.removedCount > 0 || result.failedCount > 0) {
      await emitWorkspaceCommandTelemetry(this.telemetry, {
        type: "temp_state_cleaned",
        clientInstanceId: this.clientInstanceId,
        workerId: this.workerId,
        removedCount: result.removedCount,
        failedCount: result.failedCount,
        activeCounts: await this.readActiveCounts()
      });
    }
  }

  private async recordRunningCommand(command: WorkspaceCommand): Promise<void> {
    const activeCounts = await this.readActiveCounts();
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

  private async readActiveCounts() {
    try {
      return await this.store.countActiveWorkspaceCommands({
        clientInstanceId: this.clientInstanceId
      });
    } catch {
      return undefined;
    }
  }

  private async runClaimedCommand(command: WorkspaceCommand): Promise<WorkspaceCommand> {
    const leaseToken = command.leaseToken;
    if (!leaseToken) {
      throw new Error("Workspace command must have a lease token after claim");
    }

    const controller = new AbortController();
    this.activeControllers.add(controller);
    let heartbeatInFlight = false;
    let cancellationInFlight = false;
    const heartbeatTimer = setInterval(() => {
      if (heartbeatInFlight || controller.signal.aborted) {
        return;
      }
      heartbeatInFlight = true;
      this.heartbeat(command, leaseToken)
        .catch((error: unknown) => {
          controller.abort(error instanceof Error ? error.message : "Workspace command heartbeat failed");
        })
        .finally(() => {
          heartbeatInFlight = false;
        });
    }, this.heartbeatIntervalMs);
    const cancellationTimer = setInterval(() => {
      if (cancellationInFlight || controller.signal.aborted) {
        return;
      }
      cancellationInFlight = true;
      this.pollCancellation(command, controller)
        .catch((error: unknown) => {
          controller.abort(error instanceof Error ? error.message : "Workspace command cancellation check failed");
        })
        .finally(() => {
          cancellationInFlight = false;
        });
    }, this.cancellationPollIntervalMs);

    try {
      return await this.runner.runClaimedCommand(command, {
        signal: controller.signal
      });
    } finally {
      clearInterval(heartbeatTimer);
      clearInterval(cancellationTimer);
      this.activeControllers.delete(controller);
    }
  }

  private async heartbeat(command: WorkspaceCommand, leaseToken: string): Promise<void> {
    const heartbeatAt = this.now();
    await this.store.heartbeatWorkspaceCommand({
      clientInstanceId: command.clientInstanceId,
      commandId: command.id,
      leaseToken,
      heartbeatAt,
      leaseExpiresAt: addMilliseconds(heartbeatAt, this.leaseDurationMs)
    });
  }

  private async pollCancellation(
    command: WorkspaceCommand,
    controller: AbortController
  ): Promise<void> {
    const latest = await this.store.getWorkspaceCommand({
      clientInstanceId: command.clientInstanceId,
      commandId: command.id
    });
    if (latest?.status === "cancelling") {
      controller.abort(latest.cancellationReason ?? "Workspace command was cancelled");
    }
  }
}

function staleCommandError(): WorkspaceCommandError {
  return {
    code: "WORKSPACE_COMMAND_STALE",
    message: "Workspace command lease expired before the worker completed it",
    category: "stale_lease"
  };
}

function addMilliseconds(isoDate: string, milliseconds: number): string {
  return new Date(new Date(isoDate).getTime() + milliseconds).toISOString();
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
