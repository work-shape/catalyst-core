import { randomUUID } from "node:crypto";
import type {
  ClientInstanceId,
  PlatformStore,
  WorkspaceCommand,
  WorkspaceCommandError
} from "@vivd-catalyst/core";
import { LocalWorkspaceCommandRunner } from "./workspace-command-runner";

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_LEASE_DURATION_MS = 10 * 60 * 1000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;
const DEFAULT_CANCELLATION_POLL_INTERVAL_MS = 1000;
const DEFAULT_STALE_RECOVERY_INTERVAL_MS = 30000;
const DEFAULT_STALE_RECOVERY_LIMIT = 50;

export type WorkspaceCommandWorkerStore = Pick<
  PlatformStore,
  | "claimNextWorkspaceCommand"
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
  private readonly now: () => string;
  private readonly activeControllers = new Set<AbortController>();
  private stopping = false;
  private loopPromise?: Promise<void>;
  private lastStaleRecoveryMs = 0;

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
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async runOnce(input: { recoverStale?: boolean } = {}): Promise<WorkspaceCommandWorkerRunOnceResult> {
    if (input.recoverStale ?? true) {
      await this.recoverStaleCommands();
    }
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
    const command = await this.runClaimedCommand(claimed);
    return {
      status: "claimed",
      command
    };
  }

  async recoverStaleCommands(): Promise<WorkspaceCommand[]> {
    const now = this.now();
    this.lastStaleRecoveryMs = Date.now();
    return this.store.recoverStaleWorkspaceCommands({
      clientInstanceId: this.clientInstanceId,
      staleLeaseExpiredBefore: now,
      recoveredAt: now,
      error: staleCommandError(),
      limit: this.staleRecoveryLimit
    });
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
