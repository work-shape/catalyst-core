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

export interface StoreBackedAgentRuntimeOptions {
  store: AgentRunStore & RunObservationStore;
  pollIntervalMs?: number;
  observationBatchSize?: number;
}

const TERMINAL_STATUSES = new Set<AgentRunStatus>(["completed", "cancelled", "failed"]);

export class StoreBackedAgentRuntime implements AgentRuntime {
  private readonly pollIntervalMs: number;
  private readonly observationBatchSize: number;

  constructor(private readonly options: StoreBackedAgentRuntimeOptions) {
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
    this.observationBatchSize = options.observationBatchSize ?? 100;
  }

  async start(input: StartAgentRunInput, context: RuntimeCallContext) {
    if (!input.preparedRun) {
      throw new AppError("INTERNAL", "Store-backed agent runs must be prepared before dispatch");
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
      const observations = await this.options.store.listRunObservations({
        clientInstanceId: context.clientInstanceId,
        runId,
        afterSequence: sequence,
        limit: this.observationBatchSize
      });
      for (const observation of observations) {
        sequence = observation.sequence;
        yield observation.payload;
      }
      if (observations.some((observation) => isTerminalEvent(observation.payload))) return;

      const run = await this.requireRun(runId, context);
      if (TERMINAL_STATUSES.has(run.status) && sequence >= run.lastSequence) return;
      await delay(this.pollIntervalMs, undefined, { signal: context.signal });
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

function isTerminalEvent(event: AgentRuntimeEvent): boolean {
  return (
    event.type === "run_completed" || event.type === "run_cancelled" || event.type === "run_failed"
  );
}
