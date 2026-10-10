import {
  AGENT_RUN_ADOPTION_BATCH_SIZE,
  AGENT_RUN_CANCELLATION_CHECK_INTERVAL_MS,
  AGENT_RUN_INTERRUPTED_ERROR,
  AGENT_RUN_WORKER_LOST_ERROR,
  AppError,
  JobLeaseLostError,
  adoptAgentRunsJob,
  adoptAgentRunsSchedule,
  agentRunJobOptions,
  asAgentRunId,
  defineJobHandler,
  executeAgentRunJob,
  getSubjectUserId,
  type AgentRun,
  type AgentRunError,
  type AgentRunId,
  type AgentRunJobLease,
  type AgentRuntimeEvent,
  type AuthenticatedUser,
  type ClientInstanceId,
  type ConversationHistoryStore,
  type JobControl,
  type JobSchedule,
  type PlatformStores,
  type RegisteredJobHandler,
  type RuntimeCallContext,
  type StartAgentRunInput
} from "@vivd-catalyst/core";
import { setTimeout as delay } from "node:timers/promises";
import { readUserAttachmentManifest } from "./model-context-projection";
import { LocalAgentRuntime, type LocalAgentRuntimeOptions } from "./local-agent-runtime";
import type { AgentRunSignal } from "./store-backed-agent-runtime";

// A run that stored no event for this long is ended as interrupted, so a model or a tool that
// never answers cannot hold its conversation closed. Every stored event starts the time anew.
export const AGENT_RUN_IDLE_LIMIT_MS = 30 * 60 * 1000;

/** One run in execution: its events in order, and the way to cancel it. */
export interface AgentRunExecution {
  events: AsyncIterable<AgentRuntimeEvent>;
  /**
   * Ends the run as cancelled. What the model wrote so far is stored as the assistant message
   * of the run, and the events end with `run_cancelled`.
   */
  cancel(reason: string | undefined): Promise<void>;
}

export type ExecuteAgentRun = (
  input: StartAgentRunInput,
  context: RuntimeCallContext,
  control: AgentRunExecutionControl
) => Promise<AgentRunExecution>;

export interface AgentRunExecutionControl {
  /** Rejects when the job no longer holds the run. Called before every effect of the run. */
  assertLease(): Promise<void>;
  /** The conversation of the run. Its writes carry the lease of the job. */
  conversationHistory: ConversationHistoryStore;
}

export interface AgentRunJobsOptions {
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  loadCurrentUser(run: AgentRun): Promise<AuthenticatedUser>;
  execute: ExecuteAgentRun;
  /** How many runs this process executes at once. */
  slots: number;
  /**
   * Called after an event of a run was stored. A process that serves the API too wakes its
   * observers with it; a worker process of its own has no use for it.
   */
  onObservation?(runId: AgentRunId): void;
  /**
   * Told by an API in this process when a run was asked to cancel, so the request is found at
   * once. Without it, and across processes, it is found at the next look at the row.
   */
  cancellations?: AgentRunSignal;
}

/** The job kinds the Agent Run worker serves, with their schedule. */
export interface AgentRunJobs {
  handlers: RegisteredJobHandler[];
  schedules: JobSchedule[];
}

/**
 * The one way a run executes: a worker claims its `agent_run.execute` job, the job claims the
 * run row, and every write of the run carries the lease of the job.
 */
export function createAgentRunJobs(options: AgentRunJobsOptions): AgentRunJobs {
  const { clientInstanceId, stores } = options;
  return {
    handlers: [
      defineJobHandler({
        kind: executeAgentRunJob,
        slots: options.slots,
        async run(job, control) {
          const runId = asAgentRunId(job.payload.runId);
          const lease: AgentRunJobLease = { jobId: job.id, leaseToken: control.leaseToken };
          const claim = await control.transaction(async (txStores) => {
            const claimed = await txStores.agentRuns.claimAgentRunForJob({
              clientInstanceId,
              runId,
              lease,
              leaseMs: executeAgentRunJob.leaseMs
            });
            // Someone started this run and is gone. It called models and tools already, so it
            // is ended here and never executed again.
            if (claimed.status === "started") await failLostRun(txStores, clientInstanceId, runId);
            return claimed;
          });
          if (claim.status !== "claimed") {
            // Transition release only: a worker of the previous release holds the run. This
            // job ends without waiting, so it keeps no slot, and the adoption gives the run a
            // job again for as long as it is in progress. Once that worker is done the next
            // job finds the run ended, and once its lease ran out the next job ends the run.
            if (claim.status === "held")
              control.logger.info({ runId }, "Agent run is held by a worker of the last release");
            else options.onObservation?.(runId);
            return;
          }
          const run = claim.row;
          await executeClaimedRun(options, run, lease, control);
        },
        async onHeartbeat(job, mirror, txStores) {
          await txStores.agentRuns.renewAgentRunJobLease({
            clientInstanceId,
            runId: asAgentRunId(job.payload.runId),
            lease: { jobId: job.id, leaseToken: mirror.leaseToken },
            leaseMs: executeAgentRunJob.leaseMs
          });
        },
        // The worker of the run was killed or lost its lease: the run ends in the transaction
        // that marks its job dead.
        async onExhausted(job, txStores) {
          await failLostRun(txStores, clientInstanceId, asAgentRunId(job.payload.runId));
        }
      }),
      defineJobHandler({
        kind: adoptAgentRunsJob,
        slots: 1,
        async run(_job, control) {
          // An enqueue under a live dedupe key inserts nothing, so a tick may run twice.
          const runs = await stores.agentRuns.listAgentRunsWithoutJob({
            clientInstanceId,
            jobKind: executeAgentRunJob.kind,
            limit: AGENT_RUN_ADOPTION_BATCH_SIZE
          });
          for (const run of runs) {
            await stores.jobs.enqueue(
              executeAgentRunJob,
              { runId: run.id },
              agentRunJobOptions({ clientInstanceId, ...run })
            );
          }
          if (runs.length > 0) control.logger.info({ runs: runs.length }, "Adopted agent runs");
        }
      })
    ],
    schedules: [adoptAgentRunsSchedule]
  };
}

async function failLostRun(
  stores: PlatformStores,
  clientInstanceId: ClientInstanceId,
  runId: AgentRunId
): Promise<void> {
  const failed = await stores.agentRuns.failLostAgentRun({
    clientInstanceId,
    runId,
    error: AGENT_RUN_WORKER_LOST_ERROR
  });
  if (!failed) return;
  await stores.audit.appendAuditEvent({
    clientInstanceId,
    type: "agent_run.recovered",
    status: "failed",
    subject: failed.id,
    correlationId: failed.correlationId,
    metadata: {
      conversationId: failed.conversationId,
      errorCategory: AGENT_RUN_WORKER_LOST_ERROR.category,
      errorCode: AGENT_RUN_WORKER_LOST_ERROR.code
    }
  });
}

/** Why the execution of a run was stopped from outside. */
type StopCause = "lease_lost" | "worker_stopping" | "idle";

async function executeClaimedRun(
  options: AgentRunJobsOptions,
  run: AgentRun,
  lease: AgentRunJobLease,
  control: JobControl
): Promise<void> {
  const store = options.stores.agentRuns;
  const ofRun = { clientInstanceId: run.clientInstanceId, runId: run.id };
  const now = () => new Date().toISOString();
  const controller = new AbortController();
  let stopCause: StopCause | undefined;
  let cancellation: { reason?: string } | undefined;
  let cancelExecution: ((reason: string | undefined) => Promise<void>) | undefined;
  let cancelSent = false;
  let terminalWritten = false;

  const stop = (cause: StopCause, reason: string) => {
    // The first cause stands, but a lost lease outranks the others: nothing more is stored.
    if (stopCause === undefined || cause === "lease_lost") stopCause = cause;
    controller.abort(reason);
  };
  const onJobAborted = () => {
    if (control.signal.reason instanceof JobLeaseLostError) {
      stop("lease_lost", "Agent run lease was lost");
    } else {
      stop("worker_stopping", "Agent run worker is stopping");
    }
  };
  if (control.signal.aborted) onJobAborted();
  else control.signal.addEventListener("abort", onJobAborted, { once: true });

  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const restartIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => stop("idle", "Agent run stored no event within the idle limit"),
      AGENT_RUN_IDLE_LIMIT_MS
    );
    idleTimer.unref();
  };
  restartIdleTimer();

  /** Every write of the run goes through here: the first refusal stops the run. */
  const fenced = async <Result>(write: () => Promise<Result>): Promise<Result> => {
    try {
      return await write();
    } catch (error) {
      if (error instanceof JobLeaseLostError) stop("lease_lost", "Agent run lease was lost");
      throw error;
    }
  };
  const storeEvent = (event: AgentRuntimeEvent) =>
    fenced(() => store.appendClaimedRunObservation({ ...ofRun, lease, event }));
  const append = async (event: AgentRuntimeEvent): Promise<void> => {
    try {
      await storeEvent(event);
    } catch (error) {
      // The store refuses to end a run as completed or failed once it was asked to cancel.
      // The request came between the last look at the row and this event: the run ends as
      // cancelled, with what it stored so far.
      if (event.type !== "run_completed" && event.type !== "run_failed") throw error;
      if (error instanceof JobLeaseLostError) throw error;
      const latest = await store.getAgentRun(ofRun);
      if (latest?.status !== "cancelling") throw error;
      cancellation ??= { reason: latest.cancellationReason };
      await storeEvent(cancelledEvent(run, latest.lastSequence + 1, now(), cancellation.reason));
    }
    if (isTerminalEvent(event)) terminalWritten = true;
    restartIdleTimer();
    options.onObservation?.(run.id);
  };

  const sendCancel = () => {
    if (!cancellation || !cancelExecution || cancelSent) return;
    cancelSent = true;
    cancelExecution(cancellation.reason).catch(() => {
      // The execution could not end itself as cancelled; the run is ended as cancelled below.
      controller.abort(cancellation?.reason ?? "Agent run was cancelled");
    });
  };
  // Looks for a cancellation request on the row until one is found or the execution ended.
  const watchForCancellation = async (): Promise<void> => {
    while (!cancellation) {
      const told = options.cancellations?.subscribe(run.id);
      try {
        await Promise.race([
          delay(AGENT_RUN_CANCELLATION_CHECK_INTERVAL_MS, undefined, { signal: controller.signal }),
          ...(told ? [told.wait] : [])
        ]);
      } catch {
        return;
      } finally {
        told?.stop();
      }
      if (controller.signal.aborted) return;
      const latest = await store.getAgentRun(ofRun).catch(() => undefined);
      if (latest?.status !== "cancelling") continue;
      cancellation = { reason: latest.cancellationReason };
      sendCancel();
    }
  };
  watchForCancellation().catch(() => undefined);

  /** The event that ends a run whose execution did not end it, or ended it as aborted. */
  const closingEvent = (sequence: number, failure: AgentRunError): AgentRuntimeEvent => {
    if (cancellation) return cancelledEvent(run, sequence, now(), cancellation.reason);
    if (stopCause === "worker_stopping")
      return failedEvent(run, sequence, now(), AGENT_RUN_INTERRUPTED_ERROR);
    if (stopCause === "idle") return failedEvent(run, sequence, now(), AGENT_RUN_IDLE_ERROR);
    return failedEvent(run, sequence, now(), failure);
  };
  const closeRun = async (failure: AgentRunError): Promise<void> => {
    const latest = await store.getAgentRun(ofRun);
    if (!latest) return;
    if (ENDED_STATUSES.has(latest.status)) {
      // Someone else ended the run, a worker of the previous release for one. Nothing is left
      // to store.
      terminalWritten = true;
      return;
    }
    if (latest.status === "cancelling") {
      cancellation ??= { reason: latest.cancellationReason };
    }
    await append(closingEvent(latest.lastSequence + 1, failure));
  };

  try {
    try {
      const input = await reconstructInput(options, run);
      const user = await options.loadCurrentUser(run);
      const authorization = requireAuthorization(run, user);
      const context: RuntimeCallContext = {
        user: { ...user, ...authorization },
        clientInstanceId: run.clientInstanceId,
        correlationId: run.correlationId,
        locale: run.locale,
        ...authorization,
        signal: controller.signal
      };
      const execution = await options.execute(input, context, {
        assertLease: async () => {
          await fenced(() => store.assertClaimedAgentRun({ ...ofRun, lease }));
        },
        conversationHistory: fencedConversationHistory(options, run, lease, fenced)
      });
      cancelExecution = (reason) => execution.cancel(reason);
      sendCancel();
      // The events are left the moment the run is stopped, whatever the execution does then.
      for await (const sourceEvent of eventsUntilAborted(
        execution.events,
        run.id,
        controller.signal
      )) {
        if (stopCause === "lease_lost") break;
        const event =
          sourceEvent.type === "run_failed" && (cancellation || stopCause)
            ? closingEvent(sourceEvent.sequence, sourceEvent.error)
            : sourceEvent.type === "tool_permission_requested"
              ? failedEvent(run, sourceEvent.sequence, now(), PERMISSION_UNSUPPORTED_ERROR)
              : sourceEvent;
        await append(event);
        if (terminalWritten) break;
      }
      if (!terminalWritten && stopCause !== "lease_lost") {
        await closeRun(EXECUTOR_ENDED_ERROR);
      }
    } catch (error) {
      if (terminalWritten || stopCause === "lease_lost") throw error;
      await closeRun(workerFailure(error));
    }
  } finally {
    clearTimeout(idleTimer);
    control.signal.removeEventListener("abort", onJobAborted);
    controller.abort("Agent run execution ended");
  }
  // A run this attempt could not end stays in progress. The job fails with its one attempt
  // used, and the run is ended as lost with the job.
  if (!terminalWritten) {
    throw stopCause === "lease_lost"
      ? new JobLeaseLostError(lease.jobId)
      : new AppError("INTERNAL", "Agent run did not reach a terminal state");
  }
}

async function reconstructInput(
  options: AgentRunJobsOptions,
  run: AgentRun
): Promise<StartAgentRunInput> {
  const messages = await options.stores.conversations.listMessages({
    clientInstanceId: run.clientInstanceId,
    conversationId: run.conversationId
  });
  const message = messages.find((candidate) => candidate.id === run.inputMessageId);
  if (!message || message.role !== "user") {
    throw new AppError("NOT_FOUND", "Agent run input message is not available");
  }
  const attachmentManifest = readUserAttachmentManifest(message.metadata);
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
      attachmentManifest: attachmentManifest?.attachments.length ? attachmentManifest : undefined
    }
  };
}

function fencedConversationHistory(
  options: AgentRunJobsOptions,
  run: AgentRun,
  lease: AgentRunJobLease,
  fenced: <Result>(write: () => Promise<Result>) => Promise<Result>
): ConversationHistoryStore {
  const { conversations, agentRuns } = options.stores;
  const ofRun = { clientInstanceId: run.clientInstanceId, runId: run.id, lease };
  return {
    listMessages: (input) => conversations.listMessages(input),
    listRecentMessages: (input) => conversations.listRecentMessages(input),
    appendMessage: async (message) => {
      if (message.role !== "tool") {
        throw new AppError("VALIDATION_FAILED", "An agent run may only append tool messages");
      }
      return fenced(() =>
        agentRuns.appendClaimedAgentRunMessage({ ...ofRun, message: { ...message, role: "tool" } })
      );
    },
    appendAssistantMessage: (message) =>
      fenced(() =>
        agentRuns.appendClaimedAgentRunMessage({
          ...ofRun,
          message: { ...message, role: "assistant" }
        })
      )
  };
}

export type WorkerLocalAgentRuntimeOptions = Omit<
  LocalAgentRuntimeOptions,
  "agentRunStore" | "runObservationStore" | "conversationHistory" | "beforeEffect"
>;

/**
 * Executes each run in a runtime of its own that keeps no store: the job handler stores the
 * events it yields, and its conversation writes carry the lease of the job.
 */
export function createLocalAgentRunExecutor(
  options: WorkerLocalAgentRuntimeOptions
): ExecuteAgentRun {
  return async (input, context, control) => {
    const runtime = new LocalAgentRuntime({
      ...options,
      conversationHistory: control.conversationHistory,
      beforeEffect: () => control.assertLease()
    });
    const handle = await runtime.start(input, context);
    return {
      events: runtime.observe(handle.runId, context),
      cancel: (reason) => runtime.cancel(handle.runId, reason, context)
    };
  };
}

async function* eventsUntilAborted(
  source: AsyncIterable<AgentRuntimeEvent>,
  runId: AgentRunId,
  signal: AbortSignal
): AsyncIterable<AgentRuntimeEvent> {
  const iterator = source[Symbol.asyncIterator]();
  let lastSequence = 0;
  while (true) {
    const next = await nextEventOrAbort(iterator, signal);
    if (next === "aborted") {
      yield {
        type: "run_failed",
        runId,
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
}

async function nextEventOrAbort(
  iterator: AsyncIterator<AgentRuntimeEvent>,
  signal: AbortSignal
): Promise<IteratorResult<AgentRuntimeEvent> | "aborted"> {
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

const ENDED_STATUSES = new Set<AgentRun["status"]>(["completed", "cancelled", "failed"]);

const AGENT_RUN_IDLE_ERROR: AgentRunError = {
  code: "AGENT_RUN_RUNTIME_INTERRUPTED",
  message: "Agent run stored no event within the idle limit",
  category: "runtime_interrupted"
};

const PERMISSION_UNSUPPORTED_ERROR: AgentRunError = {
  code: "AGENT_RUN_PERMISSION_UNSUPPORTED",
  message: "Permission-required tools are not supported by the Agent Worker yet",
  category: "internal_error"
};

const EXECUTOR_ENDED_ERROR: AgentRunError = {
  code: "AGENT_RUN_EXECUTOR_ENDED",
  message: "Agent run executor ended without a terminal event",
  category: "internal_error"
};

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
  error: AgentRunError
): AgentRuntimeEvent {
  return { type: "run_failed", runId: run.id, sequence, createdAt, error };
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

function workerFailure(error: unknown): AgentRunError {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.code === "INTERNAL" ? "Agent run failed" : error.message,
      category: error.code === "INTERNAL" ? "internal_error" : "app_error"
    };
  }
  return {
    code: "INTERNAL",
    message: "Agent run failed",
    category:
      error instanceof Error && error.name === "AbortError" ? "abort_error" : "internal_error"
  };
}

function isTerminalEvent(event: AgentRuntimeEvent): boolean {
  return (
    event.type === "run_completed" || event.type === "run_cancelled" || event.type === "run_failed"
  );
}
