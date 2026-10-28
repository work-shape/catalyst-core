import {
  auditActorFromUser,
  AGENT_RUN_CANCELLATION_CHECK_INTERVAL_MS,
  AGENT_RUN_INTERRUPTED_ERROR,
  AppError,
  ENDED_AGENT_RUN_STATUSES,
  JobLeaseLostError,
  adoptAgentRunsSchedule,
  agentRunIdleError,
  agentRunUpkeepHandler,
  asAgentRunId,
  createPlatformId,
  defineJobHandler,
  executeAgentRunJob,
  failAgentRunOfLostJob,
  getSubjectUserId,
  readAssistantFinalMetadata,
  readUserMessageMetadata,
  readWorkflowAgentFiles,
  workflowAgentFilesAttached,
  runFailureCodeOf,
  type AgentRun,
  type AgentRunError,
  type AgentRunId,
  type AgentRunJobLease,
  type AgentRunResumeState,
  type AgentRuntimeEvent,
  type AppendAssistantMessageInput,
  type AppendClaimedAgentRunEndInput,
  type AttachmentManifest,
  type AuthenticatedUser,
  type ChatMessage,
  type ClientInstanceId,
  type ConversationHistoryStore,
  type ConversationId,
  type SteeredUserMessage,
  type JobControl,
  type JobSchedule,
  type OperationDraftContext,
  type PlatformStores,
  type RegisteredJobHandler,
  type RuntimeCallContext,
  type StartAgentRunInput,
  type AgentRunModelOrigin
} from "@work-shape/catalyst-core";
import { setTimeout as delay } from "node:timers/promises";
import { LocalAgentRuntime, type LocalAgentRuntimeOptions } from "./local-agent-runtime";
import { readUserAttachmentManifest } from "./model-context-projection";
import type { AgentRunSignal } from "./store-backed-agent-runtime";

// A run that stored no event for this long is ended as interrupted, so a model or a tool that
// never answers cannot hold its conversation closed. Every stored event starts the time anew.
// The failure names what the run waited on; the person reads that the reply stood still.
export const AGENT_RUN_IDLE_LIMIT_MS = 30 * 60 * 1000;
// How long the watchdog reads the queue for the cause of a run that stood still.
const IDLE_CAUSE_READ_MS = 5 * 1000;
// The most events a run holds back behind its last assistant message. The runtime emits two
// events after that message, so what is held beyond them is what the run produced faster than
// it was stored. Above the limit the held message and events are stored at once and the run
// goes on unheld: its answer is kept, and a worker killed before the end of that run may
// leave the answer beside a failed run.
export const AGENT_RUN_HELD_END_MAX_EVENTS = 1000;

/** One run in execution: its events in order, and the way to cancel it. */
export interface AgentRunExecution {
  events: AsyncIterable<AgentRuntimeEvent>;
  /**
   * Ends the run as cancelled. What the model wrote so far is stored as the assistant message
   * of the run, and the events end with `run_cancelled`.
   */
  cancel(reason: string | undefined): Promise<void>;
  /**
   * What the run keeps to go on once it waits for a decision: read when its
   * `tool_decision_requested` event is stored, in the transaction that sets it waiting.
   */
  resumeState?(): AgentRunResumeState | undefined;
  /**
   * What the run keeps to go on once its events ended at the end of a step whose subagents
   * have not all ended; `undefined` for a run that does not wait for them.
   */
  waitsForSubagents?(): AgentRunResumeState | undefined;
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
  /** Takes the steers sent into the run, under the lease of the job (FU-2). */
  takeSteers(): Promise<SteeredUserMessage[]>;
}

export interface AgentRunJobsOptions {
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  loadCurrentUser(run: AgentRun): Promise<AuthenticatedUser>;
  /** A Workflow agent step's run: its agent, from the step of its run's pinned definition. */
  loadWorkflowAgent?(run: AgentRun): Promise<NonNullable<StartAgentRunInput["workflowAgent"]>>;
  /**
   * A Workflow agent step's run whose task names files of the run: attaches them to its thread,
   * waits until each is ready or refused, stores their manifest on the task message and answers
   * it. Absent where the process keeps no files: such a run fails.
   */
  attachWorkflowFiles?(input: {
    run: AgentRun;
    fileIds: readonly string[];
    signal: AbortSignal;
  }): Promise<AttachmentManifest>;
  /** A Workflow agent step's run in a draft test: the draft its calls carry. */
  loadWorkflowAgentDraft?(run: AgentRun): Promise<OperationDraftContext | undefined>;
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
  /**
   * Whether nobody watches the run, so a confirmation its calls ask waits in the Inbox of the
   * person it acts for. A scheduled start says so (EW-8). A subagent's run never is.
   */
  unattended?(run: AgentRun): boolean;
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
            if (claimed.status === "started")
              await failAgentRunOfLostJob(txStores, { clientInstanceId, runId, jobId: job.id });
            return claimed;
          });
          if (claim.status !== "claimed") {
            // Transition release only: a worker of the previous release holds the run. This
            // job ends without waiting, so it keeps no slot. That worker ends the run; when it
            // is gone and its lease ran out, the upkeep gives the run a job that fails it.
            if (claim.status === "held")
              control.logger.info({ runId }, "Agent run is held by a worker of the last release");
            else options.onObservation?.(runId);
            return;
          }
          const run = claim.row;
          await executeClaimedRun(options, run, lease, control, claim.resumeState);
        },
        async onHeartbeat(job, mirror, txStores) {
          await txStores.agentRuns.renewAgentRunJobLease({
            clientInstanceId,
            runId: asAgentRunId(job.payload.runId),
            lease: { jobId: job.id, leaseToken: mirror.leaseToken },
            leaseMs: executeAgentRunJob.leaseMs
          });
        },
        // The worker of the job was killed or lost its lease: the run ends in the transaction
        // that marks its job dead, unless someone else holds the run.
        async onExhausted(job, txStores) {
          await failAgentRunOfLostJob(txStores, {
            clientInstanceId,
            runId: asAgentRunId(job.payload.runId),
            jobId: job.id
          });
        }
      }),
      agentRunUpkeepHandler({ clientInstanceId, stores, onObservation: options.onObservation })
    ],
    schedules: [adoptAgentRunsSchedule]
  };
}

/** Why the execution of a run was stopped from outside. */
type StopCause = "lease_lost" | "worker_stopping" | "idle";

async function executeClaimedRun(
  options: AgentRunJobsOptions,
  run: AgentRun,
  lease: AgentRunJobLease,
  control: JobControl,
  resumeState: AgentRunResumeState | undefined
): Promise<void> {
  const store = options.stores.agentRuns;
  const ofRun = { clientInstanceId: run.clientInstanceId, runId: run.id };
  const now = () => new Date().toISOString();
  const controller = new AbortController();
  let stopCause: StopCause | undefined;
  let cancellation: { reason?: string } | undefined;
  let cancelExecution: ((reason: string | undefined) => Promise<void>) | undefined;
  let cancelSent = false;
  // Set once the event that ends this execution is stored: the run ended, or waits for a decision.
  let terminalWritten = false;
  let resumeStateOf: (() => AgentRunResumeState | undefined) | undefined;

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

  // The tool calls that started and have not ended, by their id, in the order they started.
  const openToolCalls = new Map<string, string>();
  let idleError: AgentRunError | undefined;
  /** What the run stands still on: the tool that is open longest, and whether its command waits. */
  const idleWait = async (): Promise<AgentRunError> => {
    const [tool] = openToolCalls.values();
    if (tool === undefined) return agentRunIdleError({});
    // A queue that cannot be read, or not in time, leaves the cause unnamed. The tool is named
    // all the same, and the stop does not wait for a database that does not answer.
    const commandUnclaimed = await withinOr(
      options.stores.executionWorkspaces
        .hasUnclaimedWorkspaceCommand({
          clientInstanceId: run.clientInstanceId,
          agentRunId: run.id
        })
        .catch(() => false),
      IDLE_CAUSE_READ_MS,
      false
    );
    return agentRunIdleError({ tool, commandUnclaimed });
  };
  /**
   * Names what the run stood still on, then stops it. The queue is read before the stop:
   * stopping the run cancels the command a tool waits for, and with it the sign of its cause.
   */
  const stopAsIdle = (): void => {
    // The read takes time. An event stored meanwhile, or the end of the run, starts a new
    // watch, and what this one found is about a run that no longer stands still.
    const watch = idleWatch;
    const stopIfStill = (error: AgentRunError) => {
      if (watch !== idleWatch) return;
      idleError = error;
      stop("idle", error.message);
    };
    idleWait().then(stopIfStill, () => stopIfStill(agentRunIdleError({})));
  };
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idleWatch = 0;
  const endIdleWatch = () => {
    idleWatch += 1;
    clearTimeout(idleTimer);
  };
  const restartIdleTimer = () => {
    endIdleWatch();
    idleTimer = setTimeout(stopAsIdle, AGENT_RUN_IDLE_LIMIT_MS);
    // A watchdog, not work: a stopped process does not wait up to the limit for a run whose
    // executor never returns.
    idleTimer.unref();
  };
  restartIdleTimer();

  // Read through a function: the cause is set from callbacks, which the compiler does not follow.
  const hasLostLease = () => stopCause === "lease_lost";
  /** Every write of the run goes through here: the first refusal stops the run. */
  const fenced = async <Result>(write: () => Promise<Result>): Promise<Result> => {
    try {
      return await write();
    } catch (error) {
      if (error instanceof JobLeaseLostError) stop("lease_lost", "Agent run lease was lost");
      throw error;
    }
  };
  /**
   * The last assistant message of the run, held back with every event consumed after it
   * until the event that ends the run: all of them are stored in one transaction. An event
   * consumed after the message may have been produced before it, so no event but the one
   * that ends the run says the answer may be stored. A worker that is killed at the end of a
   * run leaves either the whole answer with a run that ended, or a failed run without the
   * answer, never an answer beside a failed run.
   */
  let heldEnd: RunWrite | undefined;
  const storeWrite = (batch: RunWrite) => {
    // A run that pauses keeps where it goes on from, in the transaction that sets it waiting.
    const resumeState =
      batch.events.at(-1)?.type === "tool_decision_requested" ? resumeStateOf?.() : undefined;
    return fenced(() =>
      store.appendClaimedAgentRunEnd({
        ...ofRun,
        lease,
        ...batch,
        allocateSequence: true,
        ...(resumeState ? { resumeState } : {})
      })
    );
  };
  const write = async (batch: RunWrite): Promise<void> => {
    const last = batch.events.at(-1);
    try {
      await storeWrite(batch);
    } catch (error) {
      // The store refuses to end a run as completed or failed, or to let it wait, once it was
      // asked to cancel. The request came between the last look at the row and this event:
      // the run ends as cancelled, with what it stored so far and what this write carries.
      if (
        last?.type !== "run_completed" &&
        last?.type !== "run_failed" &&
        last?.type !== "tool_decision_requested"
      )
        throw error;
      if (error instanceof JobLeaseLostError) throw error;
      const latest = await store.getAgentRun(ofRun);
      if (latest?.status !== "cancelling") throw error;
      cancellation ??= { reason: latest.cancellationReason };
      await storeWrite({
        ...batch,
        events: [
          ...batch.events.slice(0, -1),
          cancelledEvent(run, last.sequence, now(), cancellation.reason)
        ]
      });
    }
    if (last && isTerminalEvent(last)) terminalWritten = true;
    restartIdleTimer();
    options.onObservation?.(run.id);
  };
  /** Stores what is held when the run goes on: it wrote to its conversation again. */
  const flushHeldEnd = async (): Promise<void> => {
    const held = heldEnd;
    heldEnd = undefined;
    if (held) await write(held);
  };
  const append = async (event: AgentRuntimeEvent): Promise<void> => {
    if (!heldEnd) return write({ events: [event] });
    if (isTerminalEvent(event)) {
      const held = heldEnd;
      heldEnd = undefined;
      return write({ ...held, events: [...held.events, event] });
    }
    heldEnd.events.push(event);
    if (heldEnd.events.length <= AGENT_RUN_HELD_END_MAX_EVENTS) return;
    control.logger.warn(
      { runId: run.id, events: heldEnd.events.length },
      "Agent run held more events behind its answer than the limit; the answer is stored now"
    );
    await flushHeldEnd();
  };
  const holdFinalMessage = (message: AppendAssistantMessageInput): ChatMessage => {
    const id = message.id ?? createPlatformId<"MessageId">("msg");
    heldEnd = { message: { ...message, id, role: "assistant" }, events: [] };
    return {
      id,
      clientInstanceId: message.clientInstanceId,
      conversationId: message.conversationId,
      role: "assistant",
      text: message.text,
      createdAt: now(),
      ...(message.metadata ? { metadata: message.metadata } : {})
    };
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
    if (stopCause === "idle")
      return failedEvent(run, sequence, now(), idleError ?? agentRunIdleError({}));
    return failedEvent(run, sequence, now(), failure);
  };
  const closeRun = async (failure: AgentRunError): Promise<void> => {
    const latest = await store.getAgentRun(ofRun);
    if (!latest) return;
    if (
      ENDED_STATUSES.has(latest.status) ||
      latest.status === "waiting_for_decision" ||
      latest.status === "waiting_for_subagents"
    ) {
      // Someone else ended the run, a worker of the previous release for one. Nothing is left
      // to store.
      terminalWritten = true;
      return;
    }
    if (latest.status === "cancelling") {
      cancellation ??= { reason: latest.cancellationReason };
    }
    // What is held is stored with the event that ends the run, after the last held event.
    const held = heldEnd;
    if (held) {
      const lastHeld = held.events.at(-1)?.sequence ?? latest.lastSequence;
      try {
        return await append(closingEvent(lastHeld + 1, failure));
      } catch (error) {
        // The answer could not be stored. The run ends without it.
        if (error instanceof JobLeaseLostError) throw error;
      }
    }
    await append(closingEvent(latest.lastSequence + 1, failure));
  };

  /**
   * A step whose subagents have not all ended ends the execution without an event: the run
   * waits for them without a lease and a job (CR-1). Once the run was asked to cancel, the
   * wait is refused and the run is ended as cancelled below.
   */
  const pauseForSubagents = async (execution: AgentRunExecution): Promise<void> => {
    const waiting = execution.waitsForSubagents?.();
    if (!waiting) return;
    await flushHeldEnd();
    try {
      await fenced(() =>
        options.stores.childAgentRuns.pauseClaimedAgentRunForSubagents({
          ...ofRun,
          lease,
          resumeState: waiting
        })
      );
      terminalWritten = true;
      options.onObservation?.(run.id);
    } catch (error) {
      if (error instanceof JobLeaseLostError) throw error;
      const latest = await store.getAgentRun(ofRun);
      if (latest?.status !== "cancelling") throw error;
      cancellation ??= { reason: latest.cancellationReason };
    }
  };

  try {
    try {
      const input = await reconstructInput(options, run, resumeState, controller.signal);
      const scheduled = await options.stores.scheduledStarts.isScheduledAgentRun({
        clientInstanceId: run.clientInstanceId,
        runId: run.id
      });
      const user = await options.loadCurrentUser(run);
      const authorization = actingFor(requireAuthorization(run, user), user);
      const workflowDraft = run.workflowStepRunId
        ? await options.loadWorkflowAgentDraft?.(run)
        : undefined;
      const context: RuntimeCallContext = {
        user: { ...user, ...authorization },
        clientInstanceId: run.clientInstanceId,
        correlationId: run.correlationId,
        locale: run.locale,
        ...authorization,
        signal: controller.signal,
        // What a tool or the runtime writes for the run beside its events and messages
        // carries the lease too: an approval request, a dropped provider continuation.
        runFence: { runId: run.id, lease },
        // A subagent never waits for a decision and starts no subagent of its own (CR-1).
        ...(run.parentRunId ? { subagent: true } : {}),
        ...(run.workflowStepRunId ? { workflowAgent: true } : {}),
        ...(run.authorization?.personalConnectionsAllowed === true ? { firstPartyRun: true } : {}),
        ...(workflowDraft ? { workflowDraft } : {}),
        ...(!run.parentRunId && (scheduled || options.unattended?.(run))
          ? { unattended: true }
          : {})
      };
      const execution = await options.execute(input, context, {
        assertLease: async () => {
          await fenced(() => store.assertClaimedAgentRun({ ...ofRun, lease }));
        },
        conversationHistory: fencedConversationHistory(options, run, lease, {
          fenced,
          holdFinalMessage,
          flushHeldEnd
        }),
        takeSteers: async () => {
          await flushHeldEnd();
          return fenced(() =>
            store.takeClaimedAgentRunSteers({
              ...ofRun,
              lease,
              actor: auditActorFromUser(user),
              correlationId: run.correlationId
            })
          );
        }
      });
      cancelExecution = (reason) => execution.cancel(reason);
      resumeStateOf = execution.resumeState;
      sendCancel();
      // The events are left the moment the run is stopped, whatever the execution does then.
      for await (const sourceEvent of eventsUntilAborted(
        execution.events,
        run,
        controller.signal
      )) {
        if (stopCause === "lease_lost") break;
        noteToolCall(openToolCalls, sourceEvent);
        const event =
          sourceEvent.type === "run_failed" && (cancellation || stopCause)
            ? closingEvent(sourceEvent.sequence, sourceEvent.error)
            : sourceEvent;
        await append(event);
        if (terminalWritten) break;
      }
      if (!terminalWritten && stopCause === undefined && !cancellation) {
        await pauseForSubagents(execution);
      }
      if (!terminalWritten && stopCause !== "lease_lost") await closeRun(EXECUTOR_ENDED_ERROR);
    } catch (error) {
      if (terminalWritten || hasLostLease()) throw error;
      await closeRun(workerFailure(error));
    }
  } finally {
    endIdleWatch();
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
  run: AgentRun,
  resumeState: AgentRunResumeState | undefined,
  signal?: AbortSignal
): Promise<StartAgentRunInput> {
  const messages = await options.stores.conversations.listMessages({
    clientInstanceId: run.clientInstanceId,
    conversationId: run.conversationId
  });
  const message = messages.find((candidate) => candidate.id === run.inputMessageId);
  if (!message || message.role !== "user") {
    throw new AppError("NOT_FOUND", "Agent run input message is not available");
  }
  const preview = readUserMessageMetadata(message.metadata)?.preview;
  const trying = await options.stores.agentTryConversations.get({
    clientInstanceId: run.clientInstanceId,
    conversationId: run.conversationId
  });
  if (
    trying &&
    (!preview || preview.agentId !== trying.agentId || preview.config.name !== run.agentName)
  )
    throw new AppError(
      "VALIDATION_FAILED",
      "The preview snapshot is not available. Send the message again in Try."
    );
  let attachmentManifest = readUserAttachmentManifest(message.metadata);
  // A Workflow step's task names the run's files: they are attached before the first turn.
  const workflowFiles = run.workflowStepRunId
    ? readWorkflowAgentFiles(message.metadata)
    : undefined;
  if (
    workflowFiles &&
    !attachmentManifest &&
    !workflowAgentFilesAttached(message.metadata) &&
    signal
  ) {
    if (!options.attachWorkflowFiles)
      throw new AppError(
        "CONFLICT",
        "This instance keeps no files, so the agent cannot read the files of its task",
        {
          reason: "files_unavailable"
        }
      );
    attachmentManifest = await options.attachWorkflowFiles({ run, fileIds: workflowFiles, signal });
  }
  const workflowAgent = run.workflowStepRunId ? await workflowAgentOf(options, run) : undefined;
  const above = run.parentRunId ? await ancestorsOf(options, run.parentRunId) : undefined;
  return {
    ...(workflowAgent ? { workflowAgent } : {}),
    ...(above
      ? { ancestors: above.ancestors, parentConversationId: above.parentConversationId }
      : {}),
    agentName: run.agentName,
    preview,
    modelBindingId: run.modelBindingId,
    reasoningEffort: run.reasoningEffort,
    conversationId: run.conversationId,
    idempotencyKey: run.idempotencyKey,
    inputMessageId: run.inputMessageId,
    preparedRun: { id: run.id, startedAt: run.startedAt },
    // A run that waited for a decision goes on where it paused, its events after the last one.
    ...(resumeState ? { resume: { state: resumeState, lastSequence: run.lastSequence } } : {}),
    message: {
      text: message.text,
      attachmentManifest: attachmentManifest?.attachments.length ? attachmentManifest : undefined
    }
  };
}

/** How many runs above a subagent are read. A subagent is never started deeper than one. */
const ANCESTORS_MAX = 4;

/**
 * What picked the model of each run above a subagent, nearest first, read as each run was
 * started (MODEL-REGION-3). A run above it that cannot be read fails the subagent's run.
 */
async function ancestorsOf(
  options: AgentRunJobsOptions,
  parentRunId: AgentRunId
): Promise<{ ancestors: AgentRunModelOrigin[]; parentConversationId?: ConversationId }> {
  const ancestors: AgentRunModelOrigin[] = [];
  let parentConversationId: ConversationId | undefined;
  let next: AgentRunId | undefined = parentRunId;
  while (next && ancestors.length < ANCESTORS_MAX) {
    const parent = await options.stores.agentRuns.getAgentRun({
      clientInstanceId: options.clientInstanceId,
      runId: next
    });
    if (!parent)
      throw new AppError("NOT_FOUND", "The run that started this subagent is not available");
    parentConversationId ??= parent.conversationId;
    const { agentName, preview, modelBindingId } = await reconstructInput(
      options,
      {
        ...parent,
        parentRunId: undefined
      },
      undefined
    );
    ancestors.push({
      agentName,
      ...(preview ? { preview } : {}),
      ...(modelBindingId ? { modelBindingId } : {})
    });
    next = parent.parentRunId;
  }
  return { ancestors, ...(parentConversationId ? { parentConversationId } : {}) };
}

function fencedConversationHistory(
  options: AgentRunJobsOptions,
  run: AgentRun,
  lease: AgentRunJobLease,
  writes: {
    fenced<Result>(write: () => Promise<Result>): Promise<Result>;
    holdFinalMessage(message: AppendAssistantMessageInput): ChatMessage;
    flushHeldEnd(): Promise<void>;
  }
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
      await writes.flushHeldEnd();
      return writes.fenced(() =>
        agentRuns.appendClaimedAgentRunMessage({ ...ofRun, message: { ...message, role: "tool" } })
      );
    },
    appendAssistantMessage: async (message) => {
      await writes.flushHeldEnd();
      // The answer that ends the run is stored with the event that ends it.
      if (readAssistantFinalMetadata(message.metadata)) return writes.holdFinalMessage(message);
      return writes.fenced(() =>
        agentRuns.appendClaimedAgentRunMessage({
          ...ofRun,
          message: { ...message, role: "assistant" }
        })
      );
    }
  };
}

/** What one transaction stores of a run: a last assistant message, and events in order. */
type RunWrite = Pick<AppendClaimedAgentRunEndInput, "message" | "events">;

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
      beforeEffect: () => control.assertLease(),
      takeSteers: () => control.takeSteers()
    });
    const handle = await runtime.start(input, context);
    return {
      events: runtime.observe(handle.runId, context),
      cancel: (reason) => runtime.cancel(handle.runId, reason, context),
      resumeState: () => runtime.resumeStateOf(handle.runId),
      waitsForSubagents: () => runtime.subagentWaitOf(handle.runId)
    };
  };
}

async function* eventsUntilAborted(
  source: AsyncIterable<AgentRuntimeEvent>,
  run: Pick<AgentRun, "id" | "lastSequence">,
  signal: AbortSignal
): AsyncIterable<AgentRuntimeEvent> {
  const runId = run.id;
  const iterator = source[Symbol.asyncIterator]();
  // A resumed run's events go on after those it stored before it paused.
  let lastSequence = run.lastSequence;
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

const ENDED_STATUSES = new Set<AgentRun["status"]>(ENDED_AGENT_RUN_STATUSES);

/** Keeps the tool calls that started and have not ended, with the name of their tool. */
function noteToolCall(open: Map<string, string>, event: AgentRuntimeEvent): void {
  if (event.type === "tool_call_started") open.set(event.toolCallId, event.toolName);
  else if (event.type === "tool_call_completed" || event.type === "tool_call_failed")
    open.delete(event.toolCallId);
}

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

function workflowAgentOf(options: AgentRunJobsOptions, run: AgentRun) {
  if (!options.loadWorkflowAgent)
    throw new AppError("NOT_FOUND", "Workflow agent definition is unavailable");
  return options.loadWorkflowAgent(run);
}

function requireAuthorization(run: AgentRun, user: AuthenticatedUser) {
  const authorization = run.authorization;
  const subjectId = run.ownerUserId ?? run.principalId;
  if (
    !authorization ||
    authorization.subjectUserId !== subjectId ||
    getSubjectUserId(user) !== subjectId ||
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

/**
 * The run's authorization, bounded by the personal key the current user was rebuilt for.
 * This also covers a Workflow agent step in a key-started test: its stored authorization
 * names no key, so the test run supplies it. Every tool call keeps the key's operation scopes
 * and the scope ceiling on the user's rights, after a pause too.
 */
function actingFor(
  authorization: ReturnType<typeof requireAuthorization>,
  user: AuthenticatedUser
): ReturnType<typeof requireAuthorization> {
  if (user.keyScopes === undefined || user.delegatedActor?.kind !== "api_key") {
    return authorization;
  }
  return {
    ...authorization,
    delegatedActor: user.delegatedActor,
    scopes: [...(user.scopes ?? [])]
  };
}

function workerFailure(error: unknown): AgentRunError {
  if (error instanceof AppError) {
    return {
      code: runFailureCodeOf(error),
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

/** An event that ends this execution of the run: the run ended, or waits for a decision. */
function isTerminalEvent(event: AgentRuntimeEvent): boolean {
  return (
    event.type === "run_completed" ||
    event.type === "run_cancelled" ||
    event.type === "run_failed" ||
    event.type === "tool_decision_requested"
  );
}

/** The value of `work`, or `otherwise` when it takes longer than `ms`. */
function withinOr<Value>(work: Promise<Value>, ms: number, otherwise: Value): Promise<Value> {
  return new Promise<Value>((resolve) => {
    const timer = setTimeout(() => resolve(otherwise), ms);
    timer.unref();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => resolve(otherwise)
    );
  });
}
