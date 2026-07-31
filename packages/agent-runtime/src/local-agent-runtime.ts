import {
  AppError,
  type AgentConfig,
  type ConfigAssetSource,
  type AgentRunHandle,
  type AgentRunId,
  type AgentRunStore,
  type AgentRunStatus,
  type AgentRuntime,
  type AgentRuntimeCommand,
  type AgentRuntimeEvent,
  type AgentRuntimeObserveOptions,
  type ChatMessage,
  type Clock,
  type ConversationHistoryStore,
  type LocaleCode,
  type ModelBindingConfig,
  type ModelProviderConfig,
  type ReasoningEffortConfig,
  type RuntimeCallContext,
  type RunObservationStore,
  type RuntimeAssetSnapshot,
  type SkillConfig,
  type StartAgentRunInput,
  type ToolExecution,
  type ToolExecutionResult,
  type WebAccessConfig,
  asAgentRunId,
  asToolCallId,
  createPlatformId,
  getRuntimeSubjectUserId,
  unknownToJsonValue,
  withoutAssistantProviderContinuation,
  systemClock
} from "@vivd-catalyst/core";
import {
  type ModelCompletion,
  type ModelMessage,
  type ModelProvider,
  type ModelToolCall
} from "@vivd-catalyst/model-provider";
import type { ToolRegistry } from "@vivd-catalyst/tool-execution";
import type { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import { RunState, toRunFailureError, type RunFailureError } from "./run-state";
import { createSystemInstructions } from "./system-instructions";
import { executeToolCall } from "./tool-call-execution";
import { recordModelUsage } from "./usage-recording";
import {
  createAssistantFinalMetadata,
  createAssistantToolCallsMetadata,
  createSubmittedUserMessageContent,
  createToolResultMetadata,
  dropCurrentSubmittedMessage,
  projectAgentVisibleHistory,
  readAssistantProviderContinuation,
  selectRecentCompleteHistory,
  stableStringify,
  type ModelOutputProjection,
  type ModelContextArtifactReader,
  type ModelContextFileReader,
  type ModelContextProjectionOptions,
  type StoredReasoningSummary
} from "./model-context-projection";
import { materializeModelTools } from "./model-tool-materialization";

export interface LocalAgentRuntimeOptions {
  assetSource: ConfigAssetSource;
  modelProviders: ModelProviderConfig[];
  modelBindings?: readonly ModelBindingConfig[];
  defaultModelProvider: ModelProviderConfig;
  conversationHistory: ConversationHistoryStore;
  agentRunStore?: AgentRunStore;
  runObservationStore?: RunObservationStore;
  modelProvider: ModelProvider;
  toolRegistry: ToolRegistry;
  toolExecution: ToolExecution;
  usageGovernance: ModelUsageGovernance;
  webAccess?: WebAccessConfig;
  historyMessageLimit?: number;
  maxSteps?: number;
  repeatedToolCallLimit?: number;
  modelContext?: ModelContextProjectionOptions;
  artifactReader?: ModelContextArtifactReader;
  clock?: Clock;
  fileReader?: ModelContextFileReader;
  runFailureReporter?: (report: LocalAgentRunFailureReport) => void | Promise<void>;
}

export interface LocalAgentRunFailureReport {
  runId: AgentRunId;
  input: StartAgentRunInput;
  context: RuntimeCallContext;
  failure: RunFailureError;
  error: unknown;
}

const DEFAULT_CONVERSATION_HISTORY_LIMIT = 20;
const DEFAULT_MAX_STEPS = 64;
const DEFAULT_REPEATED_TOOL_CALL_LIMIT = 3;
const DEFAULT_MODEL_CONTEXT: ModelContextProjectionOptions = {
  toolOutput: {
    maxTokens: 60000
  }
};

export class LocalAgentRuntime implements AgentRuntime {
  private readonly options: LocalAgentRuntimeOptions;
  private readonly runs = new Map<AgentRunId, RunState>();
  private readonly runInputs = new Map<AgentRunId, StartAgentRunInput>();
  private readonly runAbortControllers = new Map<AgentRunId, AbortController>();

  constructor(options: LocalAgentRuntimeOptions) {
    this.options = options;
  }

  async start(
    input: StartAgentRunInput,
    context: RuntimeCallContext
  ): Promise<AgentRunHandle> {
    const runId = input.preparedRun?.id ?? createPlatformId<"AgentRunId">("run");
    if (this.runs.has(runId)) {
      throw new AppError("CONFLICT", "Agent run is already active");
    }
    const state = new RunState(runId, {
      startedAt: input.preparedRun?.startedAt,
      onEvent: (event) => this.persistRunEvent(input, context, event)
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
        idempotencyKey: input.idempotencyKey,
        correlationId: context.correlationId,
        startedAt: state.startedAt
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
          this.reportRunFailure({
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

  async getStatus(
    runId: AgentRunId,
    context: RuntimeCallContext
  ): Promise<AgentRunStatus> {
    const state = this.runs.get(runId);
    if (state) {
      return state.getStatus();
    }
    const run = await this.options.agentRunStore?.getAgentRun({
      clientInstanceId: context.clientInstanceId,
      runId
    });
    if (run?.ownerUserId === getRuntimeSubjectUserId(context)) {
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
    this.runAbortControllers
      .get(runId)
      ?.abort(reason ?? "Agent run was cancelled");
    await this.options.agentRunStore?.updateAgentRunStatus({
      clientInstanceId: context.clientInstanceId,
      runId,
      status: "cancelling",
      updatedAt: new Date().toISOString()
    });
    let partialMessage: ChatMessage | undefined;
    if (partialText) {
      const conversationId =
        this.runInputs.get(runId)?.conversationId ??
        (
          await this.options.agentRunStore?.getAgentRun({
            clientInstanceId: context.clientInstanceId,
            runId
          })
        )?.conversationId;
      if (!conversationId) {
        throw new AppError("INTERNAL", "Cannot persist cancelled assistant response without a conversation id");
      }
      partialMessage = await this.options.conversationHistory.appendMessage({
        clientInstanceId: context.clientInstanceId,
        conversationId,
        role: "assistant",
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
    const state = this.getRun(runId);
    const assets = await this.options.assetSource.getSnapshot();
    const agent = getSnapshotAgentConfig(assets, input.agentName);
    const modelSelection = this.getModelSelectionForAgent(agent, input.modelBindingId);
    const tools = materializeModelTools({
      agent,
      modelProvider: modelSelection.provider,
      toolRegistry: this.options.toolRegistry,
      webAccess: this.options.webAccess
    });
    const history = await this.loadModelHistory(input, context, modelSelection.provider);
    const userContent = await createSubmittedUserMessageContent(
      input.message.text,
      input.message.attachmentManifest,
      this.modelContextOptions(context)
    );
    const messages: ModelMessage[] = [
      {
        role: "system",
        content: createSystemInstructions(agent.instructions, context.locale, {
          currentDate: this.options.clock?.now() ?? systemClock.now(),
          skills: getSnapshotSkillMetadataForAgent(assets, agent)
        })
      },
      ...history.messages,
      { role: "user", content: userContent }
    ];

    const repeatedToolCalls = new Map<string, number>();
    const maxSteps = agent.maxSteps ?? this.options.maxSteps ?? DEFAULT_MAX_STEPS;
    let providerContinuation: ModelCompletion["continuation"] = history.providerContinuation;
    let runCompacted = false;

    for (let step = 0; step < maxSteps; step += 1) {
      const { completion, emittedDeltas, reasoning } = await this.options.usageGovernance.runModelCall(
        context.clientInstanceId,
        async () => {
          const modelResult = await this.completeWithProvider(
            {
              providerId: modelSelection.provider.id,
              model: modelSelection.model,
              reasoningEffort: modelSelection.reasoningEffort,
              continuation: providerContinuation,
              messages,
              tools
            },
            context,
            state,
            true
          );
          await recordModelUsage({
            usageStore: this.options.usageGovernance,
            runId,
            startInput: input,
            context,
            provider: modelSelection.provider,
            model: modelSelection.model,
            completion: modelResult.completion
          });
          return modelResult;
        }
      );
      providerContinuation = completion.continuation;
      const compactedThisCall = completion.contextManagement?.compacted === true;
      runCompacted ||= compactedThisCall;
      const compactThresholdTokens = getProviderCompactionThreshold(modelSelection.provider);
      const modelContext =
        compactThresholdTokens === undefined
          ? undefined
          : {
              inputTokens: completion.usage.inputTokens,
              compactThresholdTokens,
              compacted: runCompacted
            };
      const persistedContinuation =
        compactedThisCall && providerContinuation
          ? {
              providerId: providerContinuation.providerId,
              state: unknownToJsonValue(providerContinuation.state)
            }
          : undefined;

      if (completion.toolCalls.length === 0) {
        if (isCancellationRequested(state.getStatus())) {
          return;
        }
        const assistantText = completion.text || completedWithoutTextFallback(context.locale);
        const persisted = await this.options.conversationHistory.appendMessage({
          clientInstanceId: context.clientInstanceId,
          conversationId: input.conversationId,
          role: "assistant",
          text: assistantText,
          metadata: createAssistantFinalMetadata({
            runId,
            reasoning,
            sources: completion.sources,
            citations: completion.citations,
            modelContext,
            providerContinuation: persistedContinuation
          })
        });
        const publicMessage = {
          ...persisted,
          metadata: withoutAssistantProviderContinuation(persisted.metadata)
        };
        if (emittedDeltas) {
          state.completeMessage(publicMessage);
        } else {
          state.message(publicMessage);
        }
        state.complete();
        return;
      }

      if (compactedThisCall) {
        removePreCompactionMessages(messages);
      }
      messages.push({
        role: "assistant",
        content: completion.text,
        toolCalls: completion.toolCalls
      });
      await this.options.conversationHistory.appendMessage({
        clientInstanceId: context.clientInstanceId,
        conversationId: input.conversationId,
        role: "assistant",
        text: completion.text,
        metadata: createAssistantToolCallsMetadata({
          runId,
          toolCalls: completion.toolCalls,
          reasoning,
          modelContext,
          providerContinuation: persistedContinuation
        })
      });

      for (const toolCall of completion.toolCalls) {
        const result = await executeToolCall({
          runId,
          startInput: input,
          context,
          state,
          toolCall,
          toolExecution: this.options.toolExecution,
          modelContext: this.modelContextOptions(context),
          repeatedToolCall: this.registerToolCall(repeatedToolCalls, toolCall.input, toolCall.toolName)
        });
        if (isCancellationRequested(state.getStatus())) {
          return;
        }
        await this.persistToolResult({
          runId,
          input,
          context,
          toolCall,
          result: result.result,
          modelOutput: result.modelOutput
        });
        messages.push({
          role: "tool",
          toolCallId: toolCall.toolCallId,
          content: result.modelOutput.content
        });
      }
    }

    state.fail(new AppError("CONFLICT", `Agent exceeded the maximum step limit of ${maxSteps}`));
  }

  private reportRunFailure(report: LocalAgentRunFailureReport): void {
    if (!this.options.runFailureReporter) {
      return;
    }
    try {
      void Promise.resolve(this.options.runFailureReporter(report)).catch(() => undefined);
    } catch {
      // A diagnostics sink must not change the user-visible run outcome.
    }
  }

  private async persistRunEvent(
    input: StartAgentRunInput,
    context: RuntimeCallContext,
    event: AgentRuntimeEvent
  ): Promise<void> {
    try {
      await this.options.runObservationStore?.appendRunObservation({
        clientInstanceId: context.clientInstanceId,
        runId: event.runId,
        conversationId: input.conversationId,
        ownerUserId: getRuntimeSubjectUserId(context),
        event
      });
    } catch (error) {
      await this.options.agentRunStore?.updateAgentRunStatus({
        clientInstanceId: context.clientInstanceId,
        runId: event.runId,
        status: "failed",
        updatedAt: event.createdAt,
        failedAt: event.createdAt,
        lastSequence: event.sequence,
        error: {
          code: "OBSERVATION_PERSISTENCE_FAILED",
          message: "Agent run observation persistence failed",
          category: "internal_error"
        }
      });
      throw error;
    }

    if (event.type === "run_completed") {
      await this.options.agentRunStore?.updateAgentRunStatus({
        clientInstanceId: context.clientInstanceId,
        runId: event.runId,
        status: "completed",
        updatedAt: event.createdAt,
        completedAt: event.createdAt,
        lastSequence: event.sequence
      });
      return;
    }

    if (event.type === "run_cancelled") {
      await this.options.agentRunStore?.updateAgentRunStatus({
        clientInstanceId: context.clientInstanceId,
        runId: event.runId,
        status: "cancelled",
        updatedAt: event.createdAt,
        cancelledAt: event.createdAt,
        lastSequence: event.sequence
      });
      return;
    }

    if (event.type === "run_failed") {
      await this.options.agentRunStore?.updateAgentRunStatus({
        clientInstanceId: context.clientInstanceId,
        runId: event.runId,
        status: "failed",
        updatedAt: event.createdAt,
        failedAt: event.createdAt,
        lastSequence: event.sequence,
        error: event.error
      });
    }
  }

  private getRun(runId: AgentRunId): RunState {
    const state = this.runs.get(runId);
    if (!state) {
      throw new AppError("NOT_FOUND", `Agent run '${runId}' was not found`);
    }
    return state;
  }

  private getModelSelectionForAgent(agent: AgentConfig, userSelectedBindingId?: string): {
    provider: ModelProviderConfig;
    model: string;
    reasoningEffort?: ReasoningEffortConfig;
  } {
    const bindingId = userSelectedBindingId ?? agent.modelBindingId;
    if (bindingId) {
      const binding = this.options.modelBindings?.find(
        (candidate) => candidate.id === bindingId
      );
      if (!binding) {
        throw new AppError("NOT_FOUND", `Model binding '${bindingId}' is not defined`);
      }
      if (userSelectedBindingId && !binding.userSelectable) {
        throw new AppError(
          "VALIDATION_FAILED",
          `Model binding '${bindingId}' is not available for user selection`
        );
      }
      const provider = this.getModelProvider(binding.providerId);
      return {
        provider,
        model: binding.model ?? provider.model,
        reasoningEffort:
          agent.reasoningEffort ??
          binding.reasoningEffort ??
          (provider.type === "openai-compatible" ? provider.reasoningEffort : undefined)
      };
    }

    const provider = this.getModelProvider(agent.modelProviderId ?? this.options.defaultModelProvider.id);
    return {
      provider,
      model: provider.model,
      reasoningEffort:
        agent.reasoningEffort ??
        (provider.type === "openai-compatible" ? provider.reasoningEffort : undefined)
    };
  }

  private getModelProvider(providerId: string): ModelProviderConfig {
    const provider = this.options.modelProviders.find((candidate) => candidate.id === providerId);
    if (!provider) {
      throw new AppError("NOT_FOUND", `Model provider '${providerId}' is not defined`);
    }
    return provider;
  }

  private async loadModelHistory(
    input: StartAgentRunInput,
    context: RuntimeCallContext,
    provider: ModelProviderConfig
  ): Promise<{
    messages: ModelMessage[];
    providerContinuation?: ModelCompletion["continuation"];
  }> {
    const persistedMessages = await this.options.conversationHistory.listMessages({
      clientInstanceId: context.clientInstanceId,
      conversationId: input.conversationId
    });
    const history = dropCurrentSubmittedMessage(persistedMessages, input.message.text);
    const compactionEnabled = getProviderCompactionThreshold(provider) !== undefined;
    const checkpointIndex = compactionEnabled
      ? findLatestCompactionCheckpointIndex(history, provider.id)
      : -1;
    const checkpoint =
      checkpointIndex >= 0
        ? readAssistantProviderContinuation(history[checkpointIndex]?.metadata)
        : undefined;
    const activeHistory = compactionEnabled
      ? history.slice(Math.max(checkpointIndex, 0))
      : selectRecentCompleteHistory(
          history,
          this.options.historyMessageLimit ?? DEFAULT_CONVERSATION_HISTORY_LIMIT
        );
    return {
      messages: await projectAgentVisibleHistory(
        activeHistory,
        this.modelContextOptions(context)
      ),
      ...(checkpoint
        ? {
            providerContinuation: {
              providerId: checkpoint.providerId,
              state: checkpoint.state
            }
          }
        : {})
    };
  }

  private async persistToolResult(input: {
    runId: AgentRunId;
    input: StartAgentRunInput;
    context: RuntimeCallContext;
    toolCall: ModelToolCall;
    result: ToolExecutionResult;
    modelOutput: ModelOutputProjection;
  }): Promise<ChatMessage> {
    return this.options.conversationHistory.appendMessage({
      clientInstanceId: input.context.clientInstanceId,
      conversationId: input.input.conversationId,
      role: "tool",
      text: input.modelOutput.text,
      metadata: createToolResultMetadata({
        runId: input.runId,
        toolCall: input.toolCall,
        result: input.result,
        modelOutput: input.modelOutput
      })
    });
  }

  private registerToolCall(
    calls: Map<string, number>,
    toolInput: unknown,
    toolName: string
  ): { repeated: boolean; count: number; limit: number } {
    const key = `${toolName}:${stableStringify(toolInput)}`;
    const count = (calls.get(key) ?? 0) + 1;
    calls.set(key, count);
    const limit = this.options.repeatedToolCallLimit ?? DEFAULT_REPEATED_TOOL_CALL_LIMIT;
    return {
      repeated: count > limit,
      count,
      limit
    };
  }

  private modelContextOptions(context: RuntimeCallContext): ModelContextProjectionOptions {
    return {
      ...(this.options.modelContext ?? DEFAULT_MODEL_CONTEXT),
      clientInstanceId: context.clientInstanceId,
      artifactReader: this.options.artifactReader,
      fileReader: this.options.fileReader
    };
  }

  private async completeWithProvider(
    request: Parameters<ModelProvider["complete"]>[0],
    context: RuntimeCallContext,
    state: RunState,
    streamText: boolean
  ): Promise<{
    completion: ModelCompletion;
    emittedDeltas: boolean;
    reasoning: StoredReasoningSummary[];
  }> {
    if (!streamText || !this.options.modelProvider.stream) {
      return {
        completion: await this.options.modelProvider.complete(request, context),
        emittedDeltas: false,
        reasoning: []
      };
    }

    let completion: ModelCompletion | undefined;
    let emittedDeltas = false;
    let streamedText = "";
    const reasoningById = new Map<string, string>();
    for await (const event of this.options.modelProvider.stream(request, context)) {
      if (event.type === "text_delta") {
        if (event.delta.length > 0) {
          emittedDeltas = true;
          streamedText += event.delta;
          state.emit({
            type: "message_delta",
            runId: state.runId,
            delta: event.delta
          });
        }
        continue;
      }
      if (event.type === "reasoning_delta") {
        if (event.delta.length > 0) {
          reasoningById.set(event.id, `${reasoningById.get(event.id) ?? ""}${event.delta}`);
          state.emit({
            type: "reasoning_delta",
            runId: state.runId,
            id: event.id,
            delta: event.delta
          });
        }
        continue;
      }
      if (event.type === "tool_call_preparing") {
        state.emit({
          type: "tool_call_preparing",
          runId: state.runId,
          toolCallId: asToolCallId(event.toolCallId),
          toolName: event.toolName
        });
        continue;
      }
      if (event.type === "provider_tool_started") {
        state.emit({
          type: "tool_call_started",
          runId: state.runId,
          toolCallId: asToolCallId(event.toolCallId),
          toolName: event.toolName,
          input: event.input ?? {}
        });
        continue;
      }
      if (event.type === "provider_tool_completed") {
        state.emit({
          type: "tool_call_completed",
          runId: state.runId,
          toolCallId: asToolCallId(event.toolCallId),
          toolName: event.toolName,
          result: {
            status: "success",
            output: event.output ?? {}
          },
          modelOutput: ""
        });
        continue;
      }
      completion = event.completion;
    }

    if (!completion) {
      throw new AppError("INTERNAL", "Model provider stream ended without a completion");
    }

    const unstreamedText = getUnstreamedCompletionText(completion.text, streamedText, emittedDeltas);
    if (unstreamedText.length > 0) {
      emittedDeltas = true;
      state.emit({
        type: "message_delta",
        runId: state.runId,
        delta: unstreamedText
      });
    }

    return {
      completion,
      emittedDeltas,
      reasoning: [...reasoningById.entries()]
        .map(([id, text]) => ({ id, text }))
        .filter((summary) => summary.text.length > 0)
    };
  }
}

function isCancellationRequested(status: AgentRunStatus): boolean {
  return status === "cancelling" || status === "cancelled";
}

function getProviderCompactionThreshold(provider: ModelProviderConfig): number | undefined {
  return provider.type === "openai-compatible"
    ? provider.contextManagement?.compaction?.compactThresholdTokens
    : undefined;
}

function findLatestCompactionCheckpointIndex(
  messages: ChatMessage[],
  providerId: string
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const continuation = readAssistantProviderContinuation(messages[index]?.metadata);
    if (continuation?.providerId === providerId) {
      return index;
    }
  }
  return -1;
}

function removePreCompactionMessages(messages: ModelMessage[]): void {
  const firstNonSystemIndex = messages.findIndex((message) => message.role !== "system");
  if (firstNonSystemIndex >= 0) {
    messages.splice(firstNonSystemIndex);
  }
}

function getUnstreamedCompletionText(
  completionText: string,
  streamedText: string,
  emittedDeltas: boolean
): string {
  if (completionText.length === 0) {
    return "";
  }
  if (!emittedDeltas) {
    return completionText;
  }
  return completionText.startsWith(streamedText) ? completionText.slice(streamedText.length) : "";
}

export function asRuntimeRunId(value: string): AgentRunId {
  return asAgentRunId(value);
}

function getSnapshotAgentConfig(assets: RuntimeAssetSnapshot, agentName: string): AgentConfig {
  const agent = assets.agents.find((candidate) => candidate.name === agentName);
  if (!agent) {
    throw new AppError("NOT_FOUND", `Agent '${agentName}' is not defined`);
  }
  return agent;
}

function getSnapshotSkillMetadataForAgent(assets: RuntimeAssetSnapshot, agent: AgentConfig) {
  const skillNames = agent.skillNames ?? [];
  if (skillNames.length === 0 || assets.skills.length === 0) {
    return [];
  }
  const skillsByName = new Map(assets.skills.map((skill) => [skill.name, skill]));
  return skillNames
    .map((skillName) => skillsByName.get(skillName))
    .filter((skill): skill is SkillConfig => Boolean(skill))
    .map(({ name, title, description }) => ({
      name,
      title,
      description
    }));
}

/**
 * Used when the model finishes a run without producing any closing text.
 * Follows the run's locale so it does not break out of the conversation
 * language the way a hardcoded English sentence did.
 */
function completedWithoutTextFallback(locale: LocaleCode | undefined): string {
  return locale === "de" ? "Ich habe die Anfrage abgeschlossen." : "I completed the request.";
}
