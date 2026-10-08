import { randomUUID } from "node:crypto";
import {
  AppError,
  type AgentRun,
  type AgentRunStore,
  type AgentRuntimeEvent,
  type AuthenticatedUser,
  type ClientInstanceId,
  type ConversationHistoryReader,
  type ConversationHistoryStore,
  type RuntimeCallContext,
  type StartAgentRunInput,
  getSubjectUserId
} from "@vivd-catalyst/core";
import { readUserAttachmentManifest } from "./model-context-projection";
import { LocalAgentRuntime, type LocalAgentRuntimeOptions } from "./local-agent-runtime";

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_LEASE_DURATION_MS = 10 * 60 * 1000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;
const DEFAULT_CANCELLATION_POLL_INTERVAL_MS = 1000;
const DEFAULT_STALE_RECOVERY_INTERVAL_MS = 30000;
const DEFAULT_STALE_RECOVERY_LIMIT = 50;

export type AgentRunWorkerStore = Pick<
  AgentRunStore,
  | "appendClaimedRunObservation"
  | "appendClaimedAgentRunMessage"
  | "assertClaimedAgentRun"
  | "claimNextAgentRun"
  | "getAgentRun"
  | "heartbeatAgentRun"
  | "recoverExpiredAgentRuns"
>;

export type ExecuteAgentRun = (
  input: StartAgentRunInput,
  context: RuntimeCallContext,
  control: AgentRunExecutionControl
) => AsyncIterable<AgentRuntimeEvent> | Promise<AsyncIterable<AgentRuntimeEvent>>;

export interface AgentRunExecutionControl {
  assertLease(): Promise<void>;
  conversationHistory: ConversationHistoryStore;
}

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

export interface AgentRunWorkerStopInput {
  interruptActive?: boolean;
  drainTimeoutMs?: number;
  reason?: string;
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
  private readonly interruptedControllers = new WeakSet<AbortController>();
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

  // Stops claiming new runs. Active runs finish on their own unless interruptActive is set
  // or drainTimeoutMs elapses first; then they end as runtime_interrupted.
  async stop(input: AgentRunWorkerStopInput = {}): Promise<void> {
    this.stopping = true;
    const interrupt = () => {
      for (const controller of this.activeControllers) {
        this.interruptedControllers.add(controller);
        controller.abort(input.reason ?? "Agent run worker is stopping");
      }
    };
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    if (input.interruptActive) interrupt();
    else if (input.drainTimeoutMs !== undefined) {
      drainTimer = setTimeout(interrupt, input.drainTimeoutMs);
    }
    try {
      await this.loopPromise;
    } finally {
      clearTimeout(drainTimer);
    }
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
      const authorization = requireAuthorization(run, user);
      const executionUser: AuthenticatedUser = {
        ...user,
        principal: authorization.principal,
        subjectUserId: authorization.subjectUserId,
        delegatedActor: authorization.delegatedActor,
        scopes: authorization.scopes
      };
      const context: RuntimeCallContext = {
        user: executionUser,
        clientInstanceId: run.clientInstanceId,
        correlationId: run.correlationId,
        locale: run.locale,
        ...authorization,
        signal: controller.signal
      };
      const assertLease = async () => {
        try {
          await this.options.store.assertClaimedAgentRun({
            clientInstanceId: run.clientInstanceId,
            runId: run.id,
            leaseToken
          });
        } catch (error) {
          const latest = await this.options.store.getAgentRun({
            clientInstanceId: run.clientInstanceId,
            runId: run.id
          });
          if (
            !latest ||
            latest.leaseToken !== leaseToken ||
            !latest.leaseExpiresAt ||
            latest.leaseExpiresAt <= this.now()
          ) {
            leaseLost = true;
            controller.abort("Agent run lease was lost");
          }
          throw error;
        }
      };
      const conversationHistory = this.workerConversationHistory(run, leaseToken);
      const events = await this.options.execute(input, context, {
        assertLease,
        conversationHistory
      });
      for await (const sourceEvent of events) {
        if (leaseLost) break;
        const event = cancellationRequested
          ? cancelledEvent(run, sourceEvent.sequence, this.now(), cancellationReason)
          : this.interruptedControllers.has(controller)
            ? interruptedEvent(run, sourceEvent.sequence, this.now())
            : sourceEvent.type === "tool_permission_requested"
              ? permissionUnsupportedEvent(run, sourceEvent.sequence, this.now())
              : sourceEvent;
        const persistedEvent = await this.appendObservationWithCancellationFallback(
          run,
          leaseToken,
          event
        );
        if (isTerminalEvent(persistedEvent)) {
          terminalWritten = true;
          controller.abort("Agent run reached a terminal state");
          break;
        }
      }
      if (!terminalWritten && !leaseLost) {
        const latest = await this.options.store.getAgentRun({
          clientInstanceId: run.clientInstanceId,
          runId: run.id
        });
        if (latest?.leaseToken === leaseToken) {
          const event =
            cancellationRequested || latest.status === "cancelling"
              ? cancelledEvent(run, latest.lastSequence + 1, this.now(), latest.cancellationReason)
              : this.interruptedControllers.has(controller)
                ? interruptedEvent(run, latest.lastSequence + 1, this.now())
                : failedEvent(run, latest.lastSequence + 1, this.now(), {
                    code: "AGENT_RUN_EXECUTOR_ENDED",
                    message: "Agent run executor ended without a terminal event",
                    category: "internal_error"
                  });
          await this.appendObservationWithCancellationFallback(run, leaseToken, event);
        }
      }
    } catch (error) {
      if (!leaseLost) {
        await this.finishAfterError(
          run,
          leaseToken,
          cancellationRequested,
          this.interruptedControllers.has(controller),
          error
        ).catch(() => undefined);
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
      reasoningEffort: run.reasoningEffort,
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

  private workerConversationHistory(run: AgentRun, leaseToken: string): ConversationHistoryStore {
    return {
      listMessages: (input) => this.options.conversationHistory.listMessages(input),
      listRecentMessages: (input) => this.options.conversationHistory.listRecentMessages(input),
      appendMessage: async (message) => {
        if (message.role !== "tool") {
          throw new AppError("VALIDATION_FAILED", "Worker runtime may only append tool messages");
        }
        return this.options.store.appendClaimedAgentRunMessage({
          clientInstanceId: run.clientInstanceId,
          runId: run.id,
          leaseToken,
          message: { ...message, role: "tool" }
        });
      },
      appendAssistantMessage: (message) =>
        this.options.store.appendClaimedAgentRunMessage({
          clientInstanceId: run.clientInstanceId,
          runId: run.id,
          leaseToken,
          message: { ...message, role: "assistant" }
        })
    };
  }

  private async finishAfterError(
    run: AgentRun,
    leaseToken: string,
    cancellationRequested: boolean,
    interrupted: boolean,
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
        : interrupted
          ? interruptedEvent(run, latest.lastSequence + 1, this.now())
          : failedEvent(run, latest.lastSequence + 1, this.now(), workerFailure(error));
    await this.appendObservationWithCancellationFallback(run, leaseToken, event);
  }

  private async appendObservationWithCancellationFallback(
    run: AgentRun,
    leaseToken: string,
    event: AgentRuntimeEvent
  ): Promise<AgentRuntimeEvent> {
    try {
      await this.options.store.appendClaimedRunObservation({
        clientInstanceId: run.clientInstanceId,
        runId: run.id,
        leaseToken,
        event
      });
      return event;
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== "CONFLICT") throw error;
      const latest = await this.options.store.getAgentRun({
        clientInstanceId: run.clientInstanceId,
        runId: run.id
      });
      if (
        event.type === "run_cancelled" ||
        latest?.leaseToken !== leaseToken ||
        latest.status !== "cancelling"
      ) {
        throw error;
      }
      const cancellation = cancelledEvent(
        run,
        latest.lastSequence + 1,
        this.now(),
        latest.cancellationReason
      );
      await this.options.store.appendClaimedRunObservation({
        clientInstanceId: run.clientInstanceId,
        runId: run.id,
        leaseToken,
        event: cancellation
      });
      return cancellation;
    }
  }
}

export type WorkerLocalAgentRuntimeOptions = Omit<
  LocalAgentRuntimeOptions,
  "agentRunStore" | "runObservationStore" | "conversationHistory" | "beforeEffect"
> & {
  agentRunStore?: never;
  runObservationStore?: never;
  conversationHistory?: never;
  beforeEffect?: never;
};

export function createWorkerLocalAgentRunExecutor(
  options: WorkerLocalAgentRuntimeOptions
): ExecuteAgentRun {
  const unsafe = options as unknown as Partial<LocalAgentRuntimeOptions>;
  if (
    unsafe.agentRunStore ||
    unsafe.runObservationStore ||
    unsafe.conversationHistory ||
    unsafe.beforeEffect
  ) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Worker LocalAgentRuntime persistence must be supplied by AgentRunWorker"
    );
  }
  return async function* (input, context, control) {
    const runtime = new LocalAgentRuntime({
      ...options,
      conversationHistory: control.conversationHistory,
      beforeEffect: () => control.assertLease()
    });
    const handle = await runtime.start(input, context);
    const iterator = runtime.observe(handle.runId, context)[Symbol.asyncIterator]();
    let lastSequence = 0;
    while (true) {
      const next = await nextEventOrAbort(iterator, context.signal);
      if (next === "aborted") {
        yield {
          type: "run_failed",
          runId: requirePreparedRunId(input),
          sequence: lastSequence + 1,
          createdAt: new Date().toISOString(),
          error: {
            code: "AGENT_RUN_ABORTED",
            message: "Agent run execution was interrupted",
            category: "abort_error"
          }
        };
        return;
      }
      if (next.done) return;
      lastSequence = next.value.sequence;
      yield next.value;
    }
  };
}

async function nextEventOrAbort(
  iterator: AsyncIterator<AgentRuntimeEvent>,
  signal: AbortSignal | undefined
): Promise<IteratorResult<AgentRuntimeEvent> | "aborted"> {
  if (!signal) return iterator.next();
  if (signal.aborted) return "aborted";
  let onAbort!: () => void;
  const aborted = new Promise<"aborted">((resolve) => {
    onAbort = () => resolve("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([iterator.next(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function requirePreparedRunId(input: StartAgentRunInput) {
  if (!input.preparedRun) {
    throw new AppError("INTERNAL", "Worker execution requires a prepared Agent Run");
  }
  return input.preparedRun.id;
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

function interruptedEvent(run: AgentRun, sequence: number, createdAt: string): AgentRuntimeEvent {
  return failedEvent(run, sequence, createdAt, {
    ...AGENT_RUN_INTERRUPTED_ERROR,
    message: "Agent run worker stopped before completion"
  });
}

function permissionUnsupportedEvent(
  run: AgentRun,
  sequence: number,
  createdAt: string
): AgentRuntimeEvent {
  return failedEvent(run, sequence, createdAt, {
    code: "AGENT_RUN_PERMISSION_UNSUPPORTED",
    message: "Permission-required tools are not supported by the Agent Worker yet",
    category: "internal_error"
  });
}

function requireAuthorization(run: AgentRun, user: AuthenticatedUser) {
  const authorization = run.authorization;
  if (
    !authorization ||
    authorization.subjectUserId !== run.ownerUserId ||
    getSubjectUserId(user) !== run.ownerUserId ||
    user.clientInstanceId !== run.clientInstanceId ||
    authorization.principal.clientInstanceId !== run.clientInstanceId ||
    !Array.isArray(authorization.scopes) ||
    authorization.scopes.some((scope) => typeof scope !== "string")
  ) {
    throw new AppError("FORBIDDEN", "Agent run authorization context is unavailable or invalid");
  }
  return {
    principal: authorization.principal,
    subjectUserId: authorization.subjectUserId,
    delegatedActor: authorization.delegatedActor,
    scopes: [...authorization.scopes]
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
