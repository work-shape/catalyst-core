import { randomUUID } from "node:crypto";
import {
  AppError,
  type AgentRun,
  type AgentRunStore,
  type AgentRuntime,
  type AgentRuntimeEvent,
  type AuthenticatedUser,
  type ClientInstanceId,
  type ConversationHistoryReader,
  type RuntimeCallContext,
  type StartAgentRunInput,
  authContextFromUser
} from "@vivd-catalyst/core";
import { readUserAttachmentManifest } from "./model-context-projection";

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_LEASE_DURATION_MS = 10 * 60 * 1000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;
const DEFAULT_CANCELLATION_POLL_INTERVAL_MS = 1000;
const DEFAULT_STALE_RECOVERY_INTERVAL_MS = 30000;
const DEFAULT_STALE_RECOVERY_LIMIT = 50;

export type AgentRunWorkerStore = Pick<
  AgentRunStore,
  | "appendClaimedRunObservation"
  | "claimNextAgentRun"
  | "getAgentRun"
  | "heartbeatAgentRun"
  | "recoverExpiredAgentRuns"
>;

export type ExecuteAgentRun = (
  input: StartAgentRunInput,
  context: RuntimeCallContext
) => AsyncIterable<AgentRuntimeEvent> | Promise<AsyncIterable<AgentRuntimeEvent>>;

export interface AgentRunWorkerOptions {
  clientInstanceId: ClientInstanceId;
  store: AgentRunWorkerStore;
  conversationHistory: ConversationHistoryReader;
  loadCurrentUser(run: AgentRun): Promise<AuthenticatedUser>;
  execute: ExecuteAgentRun;
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

export interface AgentRunWorkerRunOnceResult {
  status: "claimed" | "idle";
  run?: AgentRun;
}

export const AGENT_RUN_INTERRUPTED_ERROR = {
  code: "AGENT_RUN_RUNTIME_INTERRUPTED",
  message: "Agent run lease expired before the worker completed it",
  category: "runtime_interrupted" as const
};

export class AgentRunWorker {
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

  constructor(private readonly options: AgentRunWorkerOptions) {
    this.workerId = options.workerId ?? `agent-run-worker-${randomUUID()}`;
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

  async runOnce(input: { recoverExpired?: boolean } = {}): Promise<AgentRunWorkerRunOnceResult> {
    if (input.recoverExpired ?? true) await this.recoverExpiredRuns();
    const now = this.now();
    const claimed = await this.options.store.claimNextAgentRun({
      clientInstanceId: this.options.clientInstanceId,
      workerId: this.workerId,
      leaseToken: randomUUID(),
      now,
      leaseExpiresAt: addMilliseconds(now, this.leaseDurationMs)
    });
    if (!claimed) return { status: "idle" };
    return { status: "claimed", run: await this.runClaimed(claimed) };
  }

  recoverExpiredRuns(): Promise<AgentRun[]> {
    const now = this.now();
    this.lastStaleRecoveryMs = Date.now();
    return this.options.store.recoverExpiredAgentRuns({
      clientInstanceId: this.options.clientInstanceId,
      leaseExpiredBefore: now,
      recoveredAt: now,
      error: AGENT_RUN_INTERRUPTED_ERROR,
      limit: this.staleRecoveryLimit
    });
  }

  start(): Promise<void> {
    if (!this.loopPromise) {
      this.stopping = false;
      this.loopPromise = Promise.all(
        Array.from({ length: this.concurrency }, () => this.runLoop())
      ).then(() => undefined);
    }
    return this.loopPromise;
  }

  runUntilStopped(): Promise<void> {
    return this.start();
  }

  async stop(input: { interruptActive?: boolean; reason?: string } = {}): Promise<void> {
    this.stopping = true;
    if (input.interruptActive) {
      for (const controller of this.activeControllers) {
        controller.abort(input.reason ?? "Agent run worker is stopping");
      }
    }
    await this.loopPromise;
    this.loopPromise = undefined;
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      if (Date.now() - this.lastStaleRecoveryMs >= this.staleRecoveryIntervalMs) {
        await this.recoverExpiredRuns();
      }
      const result = await this.runOnce({ recoverExpired: false });
      if (result.status === "idle") await sleep(this.pollIntervalMs);
    }
  }

  private async runClaimed(run: AgentRun): Promise<AgentRun> {
    const leaseToken = run.leaseToken;
    if (!leaseToken) throw new AppError("INTERNAL", "Claimed agent run has no lease token");
    const controller = new AbortController();
    this.activeControllers.add(controller);
    let cancellationRequested = run.status === "cancelling";
    let cancellationReason = run.cancellationReason;
    let leaseLost = false;
    let terminalWritten = false;
    let heartbeatInFlight = false;
    let cancellationInFlight = false;

    const heartbeatTimer = setInterval(() => {
      if (heartbeatInFlight || controller.signal.aborted) return;
      heartbeatInFlight = true;
      const heartbeatAt = this.now();
      this.options.store
        .heartbeatAgentRun({
          clientInstanceId: run.clientInstanceId,
          runId: run.id,
          leaseToken,
          heartbeatAt,
          leaseExpiresAt: addMilliseconds(heartbeatAt, this.leaseDurationMs)
        })
        .catch(() => {
          leaseLost = true;
          controller.abort("Agent run lease was lost");
        })
        .finally(() => {
          heartbeatInFlight = false;
        });
    }, this.heartbeatIntervalMs);
    const cancellationTimer = setInterval(() => {
      if (cancellationInFlight || controller.signal.aborted) return;
      cancellationInFlight = true;
      this.options.store
        .getAgentRun({ clientInstanceId: run.clientInstanceId, runId: run.id })
        .then((latest) => {
          if (latest?.status === "cancelling") {
            cancellationRequested = true;
            cancellationReason = latest.cancellationReason;
            controller.abort(latest.cancellationReason ?? "Agent run was cancelled");
          }
        })
        .catch(() => undefined)
        .finally(() => {
          cancellationInFlight = false;
        });
    }, this.cancellationPollIntervalMs);

    try {
      const input = await this.reconstructInput(run);
      const user = await this.options.loadCurrentUser(run);
      const context: RuntimeCallContext = {
        user,
        clientInstanceId: run.clientInstanceId,
        correlationId: run.correlationId,
        locale: run.locale,
        subjectUserId: run.ownerUserId,
        ...authContextFromUser(user),
        signal: controller.signal
      };
      const events = await this.options.execute(input, context);
      for await (const sourceEvent of events) {
        if (leaseLost || (this.stopping && controller.signal.aborted)) break;
        const event = cancellationRequested
          ? cancelledEvent(run, sourceEvent.sequence, this.now(), cancellationReason)
          : sourceEvent;
        await this.options.store.appendClaimedRunObservation({
          clientInstanceId: run.clientInstanceId,
          runId: run.id,
          leaseToken,
          event
        });
        if (isTerminalEvent(event)) {
          terminalWritten = true;
          break;
        }
      }
      if (!terminalWritten && !leaseLost && !(this.stopping && controller.signal.aborted)) {
        const latest = await this.options.store.getAgentRun({
          clientInstanceId: run.clientInstanceId,
          runId: run.id
        });
        if (latest?.leaseToken === leaseToken) {
          const event =
            cancellationRequested || latest.status === "cancelling"
              ? cancelledEvent(run, latest.lastSequence + 1, this.now(), latest.cancellationReason)
              : failedEvent(run, latest.lastSequence + 1, this.now(), {
                  code: "AGENT_RUN_EXECUTOR_ENDED",
                  message: "Agent run executor ended without a terminal event",
                  category: "internal_error"
                });
          await this.options.store.appendClaimedRunObservation({
            clientInstanceId: run.clientInstanceId,
            runId: run.id,
            leaseToken,
            event
          });
        }
      }
    } catch (error) {
      if (!leaseLost && !(this.stopping && controller.signal.aborted)) {
        await this.finishAfterError(run, leaseToken, cancellationRequested, error).catch(
          () => undefined
        );
      }
    } finally {
      clearInterval(heartbeatTimer);
      clearInterval(cancellationTimer);
      this.activeControllers.delete(controller);
    }
    return (
      (await this.options.store.getAgentRun({
        clientInstanceId: run.clientInstanceId,
        runId: run.id
      })) ?? run
    );
  }

  private async reconstructInput(run: AgentRun): Promise<StartAgentRunInput> {
    const messages = await this.options.conversationHistory.listMessages({
      clientInstanceId: run.clientInstanceId,
      conversationId: run.conversationId
    });
    const message = messages.find((candidate) => candidate.id === run.inputMessageId);
    if (!message || message.role !== "user") {
      throw new AppError("NOT_FOUND", "Agent run input message is not available");
    }
    return {
      agentName: run.agentName,
      modelBindingId: run.modelBindingId,
      conversationId: run.conversationId,
      idempotencyKey: run.idempotencyKey,
      inputMessageId: run.inputMessageId,
      preparedRun: { id: run.id, startedAt: run.startedAt },
      message: {
        text: message.text,
        attachmentManifest: readUserAttachmentManifest(message.metadata)
      }
    };
  }

  private async finishAfterError(
    run: AgentRun,
    leaseToken: string,
    cancellationRequested: boolean,
    error: unknown
  ): Promise<void> {
    const latest = await this.options.store.getAgentRun({
      clientInstanceId: run.clientInstanceId,
      runId: run.id
    });
    if (!latest || latest.leaseToken !== leaseToken) return;
    const event =
      cancellationRequested || latest.status === "cancelling"
        ? cancelledEvent(run, latest.lastSequence + 1, this.now(), latest.cancellationReason)
        : failedEvent(run, latest.lastSequence + 1, this.now(), workerFailure(error));
    await this.options.store.appendClaimedRunObservation({
      clientInstanceId: run.clientInstanceId,
      runId: run.id,
      leaseToken,
      event
    });
  }
}

/**
 * The runtime must not persist Agent Run rows or Run Observations itself.
 * AgentRunWorker is the sole lease-fenced writer for that state.
 */
export function executeWithAgentRuntime(runtime: AgentRuntime): ExecuteAgentRun {
  return async (input, context) => {
    const handle = await runtime.start(input, context);
    return runtime.observe(handle.runId, context);
  };
}

function cancelledEvent(
  run: AgentRun,
  sequence: number,
  createdAt: string,
  reason?: string
): AgentRuntimeEvent {
  return {
    type: "run_cancelled",
    runId: run.id,
    sequence,
    createdAt,
    ...(reason ? { reason } : {})
  };
}

function failedEvent(
  run: AgentRun,
  sequence: number,
  createdAt: string,
  error: Extract<AgentRuntimeEvent, { type: "run_failed" }>["error"]
): AgentRuntimeEvent {
  return { type: "run_failed", runId: run.id, sequence, createdAt, error };
}

function workerFailure(error: unknown) {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.code === "INTERNAL" ? "Agent run failed" : error.message,
      category: error.code === "INTERNAL" ? ("internal_error" as const) : ("app_error" as const)
    };
  }
  return {
    code: "INTERNAL",
    message: "Agent run failed",
    category:
      error instanceof Error && error.name === "AbortError"
        ? ("abort_error" as const)
        : ("internal_error" as const)
  };
}

function isTerminalEvent(event: AgentRuntimeEvent): boolean {
  return (
    event.type === "run_completed" || event.type === "run_cancelled" || event.type === "run_failed"
  );
}

function addMilliseconds(isoDate: string, milliseconds: number): string {
  return new Date(new Date(isoDate).getTime() + milliseconds).toISOString();
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
