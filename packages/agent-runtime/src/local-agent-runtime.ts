import {
  AppError,
  type AgentRunHandle,
  type AgentRunId,
  type AgentRunStatus,
  type AgentRuntime,
  type AgentRuntimeCommand,
  type AgentRuntimeEvent,
  type AgentRuntimeObserveOptions,
  type ChatMessage,
  type RuntimeCallContext,
  type StartAgentRunInput,
  asAgentRunId,
  createPlatformId,
  getAuthPrincipal,
  getAuthScopes,
  getRuntimeSubjectUserId
} from "@vivd-catalyst/core";
import { RunState, toRunFailureError } from "./run-state";
import { createAssistantFinalMetadata } from "./model-context-projection";
import { ModelInput, getProviderCompactionThreshold } from "./run/model-input";
import { RunEvents, type LocalAgentRuntimeOptions } from "./run/run-events";
import { ToolDispatch } from "./run/tool-dispatch";
import { TurnLoop } from "./run/turn-loop";

export type {
  LocalAgentRuntimeOptions,
  LocalAgentRuntimeEffect,
  LocalAgentRunFailureReport
} from "./run/run-events";

export class LocalAgentRuntime implements AgentRuntime {
  private readonly options: LocalAgentRuntimeOptions;
  private readonly runEvents: RunEvents;
  private readonly turnLoop: TurnLoop;
  private readonly runs = new Map<AgentRunId, RunState>();
  private readonly runInputs = new Map<AgentRunId, StartAgentRunInput>();
  private readonly runAbortControllers = new Map<AgentRunId, AbortController>();

  constructor(options: LocalAgentRuntimeOptions) {
    if (
      !options.modelProviderContinuationStore &&
      options.modelProviders.some(
        (provider) =>
          getProviderCompactionThreshold(
            provider,
            options.modelGateway.capabilities({ providerId: provider.id })
          ) !== undefined
      )
    ) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Model provider compaction requires a model provider continuation store"
      );
    }
    this.options = options;
    this.runEvents = new RunEvents(options);
    const modelInput = new ModelInput(options);
    const toolDispatch = new ToolDispatch(options, modelInput, this.runEvents);
    this.turnLoop = new TurnLoop(options, modelInput, toolDispatch, this.runEvents);
  }

  async start(input: StartAgentRunInput, context: RuntimeCallContext): Promise<AgentRunHandle> {
    const runId = input.preparedRun?.id ?? createPlatformId<"AgentRunId">("run");
    if (this.runs.has(runId)) {
      throw new AppError("CONFLICT", "Agent run is already active");
    }
    const state = new RunState(runId, {
      startedAt: input.preparedRun?.startedAt,
      onEvent: (event) => this.runEvents.persistRunEvent(input, context, event)
    });
    if (this.options.agentRunStore && !input.preparedRun) {
      if (!input.inputMessageId) {
        throw new AppError("INTERNAL", "Durable agent runs require an input message id");
      }
      await this.options.agentRunStore.createAgentRun({
        id: runId,
        clientInstanceId: context.clientInstanceId,
        conversationId: input.conversationId,
        ownerUserId: getRuntimeSubjectUserId(context),
        inputMessageId: input.inputMessageId,
        agentName: input.agentName,
        modelBindingId: input.modelBindingId,
        reasoningEffort: input.reasoningEffort,
        locale: context.locale,
        authorization: {
          principal: context.principal ?? getAuthPrincipal(context.user),
          subjectUserId: context.subjectUserId ?? getRuntimeSubjectUserId(context),
          delegatedActor: context.delegatedActor ?? context.user.delegatedActor,
          scopes: [...(context.scopes ?? getAuthScopes(context.user))]
        },
        status: "running",
        idempotencyKey: input.idempotencyKey,
        correlationId: context.correlationId,
        startedAt: state.startedAt
      });
    } else if (this.options.agentRunStore && input.preparedRun) {
      await this.options.agentRunStore.updateAgentRunStatus({
        clientInstanceId: context.clientInstanceId,
        runId,
        status: "running",
        updatedAt: new Date().toISOString()
      });
    }
    this.runs.set(runId, state);
    this.runInputs.set(runId, input);
    const runAbortController = new AbortController();
    const abortFromCaller = () => runAbortController.abort(context.signal?.reason);
    if (context.signal?.aborted) {
      abortFromCaller();
    } else {
      context.signal?.addEventListener("abort", abortFromCaller, { once: true });
    }
    this.runAbortControllers.set(runId, runAbortController);
    const runContext = {
      ...context,
      signal: runAbortController.signal
    };

    queueMicrotask(() => {
      void this.executeRun(runId, input, runContext)
        .catch((error) => {
          const failure = toRunFailureError(error);
          this.runEvents.reportRunFailure({
            runId,
            input,
            context: runContext,
            failure,
            error
          });
          state.fail(error, failure);
        })
        .finally(() => {
          context.signal?.removeEventListener("abort", abortFromCaller);
          this.runAbortControllers.delete(runId);
        });
    });

    return {
      runId,
      status: "running",
      startedAt: state.startedAt
    };
  }

  observe(runId: AgentRunId): AsyncIterable<AgentRuntimeEvent>;
  observe(
    runId: AgentRunId,
    context: RuntimeCallContext,
    options?: AgentRuntimeObserveOptions
  ): AsyncIterable<AgentRuntimeEvent>;
  observe(
    runId: AgentRunId,
    _context?: RuntimeCallContext,
    options?: AgentRuntimeObserveOptions
  ): AsyncIterable<AgentRuntimeEvent> {
    const state = this.getRun(runId);
    return state.observe(options);
  }

  async getStatus(runId: AgentRunId, context: RuntimeCallContext): Promise<AgentRunStatus> {
    const state = this.runs.get(runId);
    if (state) {
      return state.getStatus();
    }
    const run = await this.options.agentRunStore?.getAgentRun({
      clientInstanceId: context.clientInstanceId,
      runId
    });
    if (run) {
      return run.status;
    }
    throw new AppError("NOT_FOUND", `Agent run '${runId}' was not found`);
  }

  async resume(
    runId: AgentRunId,
    _command: AgentRuntimeCommand,
    _context: RuntimeCallContext
  ): Promise<void> {
    this.getRun(runId);
    throw new AppError(
      "CONFLICT",
      "This local runtime exposes the resume interface, but v1 HTTP chat does not yet resume paused runs"
    );
  }

  async cancel(
    runId: AgentRunId,
    reason: string | undefined,
    context: RuntimeCallContext
  ): Promise<void> {
    const state = this.getRun(runId);
    const partialText = state.beginCancellation();
    this.runAbortControllers.get(runId)?.abort(reason ?? "Agent run was cancelled");
    await this.options.agentRunStore?.updateAgentRunStatus({
      clientInstanceId: context.clientInstanceId,
      runId,
      status: "cancelling",
      updatedAt: new Date().toISOString()
    });
    let partialMessage: ChatMessage | undefined;
    if (partialText) {
      await this.runEvents.beforeEffect("assistant_message", runId);
      const conversationId =
        this.runInputs.get(runId)?.conversationId ??
        (
          await this.options.agentRunStore?.getAgentRun({
            clientInstanceId: context.clientInstanceId,
            runId
          })
        )?.conversationId;
      if (!conversationId) {
        throw new AppError(
          "INTERNAL",
          "Cannot persist cancelled assistant response without a conversation id"
        );
      }
      partialMessage = await this.options.conversationHistory.appendAssistantMessage({
        clientInstanceId: context.clientInstanceId,
        conversationId,
        text: partialText,
        metadata: createAssistantFinalMetadata({
          runId,
          reasoning: state.getReasoningSummaries(),
          sources: [],
          citations: [],
          finishStatus: "cancelled",
          cancellationReason: reason
        })
      });
    }
    state.cancel(reason, partialMessage);
    await state.waitForEventWrites();
  }

  private async executeRun(
    runId: AgentRunId,
    input: StartAgentRunInput,
    context: RuntimeCallContext
  ): Promise<void> {
    await this.turnLoop.executeRun(this.getRun(runId), runId, input, context);
  }

  private getRun(runId: AgentRunId): RunState {
    const state = this.runs.get(runId);
    if (!state) {
      throw new AppError("NOT_FOUND", `Agent run '${runId}' was not found`);
    }
    return state;
  }
}

export function asRuntimeRunId(value: string): AgentRunId {
  return asAgentRunId(value);
}
