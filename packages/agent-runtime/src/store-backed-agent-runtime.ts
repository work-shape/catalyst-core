import {
  AppError,
  type AgentRun,
  type AgentRunId,
  type AgentRunStore,
  type AgentRunStatus,
  type AgentRuntime,
  type AgentRuntimeCommand,
  type AgentRuntimeEvent,
  type AgentRuntimeObserveOptions,
  type RuntimeCallContext,
  type RunObservationStore,
  type StartAgentRunInput
} from "@vivd-catalyst/core";
import { setTimeout as delay } from "node:timers/promises";

// How often an observer reads the store for new events of a run that a worker in another
// process executes. A token reaches the browser at most this long after it was stored.
const OBSERVATION_POLL_INTERVAL_MS = 500;
// Events one read of an observer returns.
const OBSERVATION_BATCH_SIZE = 100;

/**
 * A signal between the API and a worker that run in one process, keyed by run. It carries no
 * data: the one who hears it reads the store. Two processes have no such signal and poll.
 */
export interface AgentRunSignal {
  /** Wakes everyone who waits for the run. */
  notify(runId: AgentRunId): void;
  /** Resolves `wait` at the next `notify` for the run. `stop` ends the subscription. */
  subscribe(runId: AgentRunId): { wait: Promise<void>; stop(): void };
}

export function createAgentRunSignal(): AgentRunSignal {
  const waiting = new Map<AgentRunId, Set<() => void>>();
  return {
    notify(runId) {
      const resolvers = waiting.get(runId);
      if (!resolvers) return;
      waiting.delete(runId);
      for (const resolve of resolvers) resolve();
    },
    subscribe(runId) {
      let resolver: () => void = () => undefined;
      const wait = new Promise<void>((resolve) => {
        resolver = resolve;
      });
      const resolvers = waiting.get(runId) ?? new Set();
      waiting.set(runId, resolvers);
      resolvers.add(resolver);
      return {
        wait,
        stop() {
          resolvers.delete(resolver);
          if (resolvers.size === 0 && waiting.get(runId) === resolvers) waiting.delete(runId);
        }
      };
    }
  };
}

export interface StoreBackedAgentRuntimeOptions {
  store: AgentRunStore & RunObservationStore;
  /**
   * Present when the runs execute in this process. The worker tells of every stored event, so
   * an observer reads it at once and not at its next poll.
   */
  observations?: AgentRunSignal;
  /**
   * Present when the runs execute in this process. The worker hears of a cancellation request
   * at once and not at its next look at the row.
   */
  cancellations?: AgentRunSignal;
}

const TERMINAL_STATUSES = new Set<AgentRunStatus>(["completed", "cancelled", "failed"]);

/**
 * The API's side of a run. The run is a row and a job: a worker executes it and stores its
 * events, and this reads them back. It executes nothing itself.
 */
export class StoreBackedAgentRuntime implements AgentRuntime {
  constructor(private readonly options: StoreBackedAgentRuntimeOptions) {}

  async start(input: StartAgentRunInput, context: RuntimeCallContext) {
    if (!input.preparedRun) {
      throw new AppError("INTERNAL", "Agent runs must be accepted before dispatch");
    }
    const run = await this.requireRun(input.preparedRun.id, context);
    if (
      run.conversationId !== input.conversationId ||
      run.inputMessageId !== input.inputMessageId ||
      run.agentName !== input.agentName ||
      run.modelBindingId !== input.modelBindingId ||
      run.reasoningEffort !== input.reasoningEffort
    ) {
      throw new AppError("CONFLICT", "Prepared agent run does not match its dispatch input");
    }
    return { runId: run.id, status: run.status, startedAt: run.startedAt };
  }

  async *observe(
    runId: AgentRunId,
    context: RuntimeCallContext,
    options: AgentRuntimeObserveOptions = {}
  ): AsyncIterable<AgentRuntimeEvent> {
    await this.requireRun(runId, context);
    let sequence = options.afterSequence ?? 0;
    while (true) {
      // Subscribed before the read: an event stored after the read still ends the wait.
      const stored = this.options.observations?.subscribe(runId);
      try {
        const observations = await this.options.store.listRunObservations({
          clientInstanceId: context.clientInstanceId,
          runId,
          afterSequence: sequence,
          limit: OBSERVATION_BATCH_SIZE
        });
        for (const observation of observations) {
          sequence = observation.sequence;
          yield observation.payload;
        }
        if (observations.some((observation) => isTerminalEvent(observation.payload))) return;
        // A full batch has more behind it, and a run is read only when no event came.
        if (observations.length > 0) continue;

        const run = await this.requireRun(runId, context);
        if (TERMINAL_STATUSES.has(run.status) && sequence >= run.lastSequence) return;
        await waitForNextRead(stored?.wait, context.signal);
      } finally {
        stored?.stop();
      }
    }
  }

  async getStatus(runId: AgentRunId, context: RuntimeCallContext): Promise<AgentRunStatus> {
    return (await this.requireRun(runId, context)).status;
  }

  async resume(
    runId: AgentRunId,
    _command: AgentRuntimeCommand,
    context: RuntimeCallContext
  ): Promise<void> {
    await this.requireRun(runId, context);
    throw new AppError("CONFLICT", "Store-backed agent runs do not support resume yet");
  }

  async cancel(
    runId: AgentRunId,
    reason: string | undefined,
    context: RuntimeCallContext
  ): Promise<void> {
    await this.requireRun(runId, context);
    await this.options.store.requestAgentRunCancellation({
      clientInstanceId: context.clientInstanceId,
      runId,
      requestedAt: new Date().toISOString(),
      reason
    });
    this.options.cancellations?.notify(runId);
  }

  // Callers authorize access to the run's Conversation; any authorized viewer may observe or
  // cancel it, not only the user who started it.
  private async requireRun(runId: AgentRunId, context: RuntimeCallContext): Promise<AgentRun> {
    const run = await this.options.store.getAgentRun({
      clientInstanceId: context.clientInstanceId,
      runId
    });
    if (!run) {
      throw new AppError("NOT_FOUND", `Agent run '${runId}' was not found`);
    }
    return run;
  }
}

/** Resolves at the next poll, or earlier when `stored` does. Rejects when the caller left. */
async function waitForNextRead(
  stored: Promise<void> | undefined,
  signal: AbortSignal | undefined
): Promise<void> {
  const woken = new AbortController();
  stored?.then(
    () => woken.abort(),
    () => undefined
  );
  try {
    await delay(OBSERVATION_POLL_INTERVAL_MS, undefined, {
      signal: signal ? AbortSignal.any([signal, woken.signal]) : woken.signal
    });
  } catch (error) {
    if (!woken.signal.aborted || signal?.aborted) throw error;
  }
}

function isTerminalEvent(event: AgentRuntimeEvent): boolean {
  return (
    event.type === "run_completed" || event.type === "run_cancelled" || event.type === "run_failed"
  );
}
