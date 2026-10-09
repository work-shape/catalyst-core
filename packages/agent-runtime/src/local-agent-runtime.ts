import {
  AppError,
  defaultReasoningEffortForAgentBinding,
  isModelBindingUserSelectableForAgent,
  reasoningEffortChoiceForBinding,
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
  type ClientInstanceId,
  type Clock,
  type ConversationHistoryStore,
  type LocaleCode,
  type ModelBindingConfig,
  type ModelProviderContinuationStore,
  type ModelProviderConfig,
  type ModelUsageRecorder,
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
  getAuthPrincipal,
  getAuthScopes,
  getRuntimeSubjectUserId,
  unknownToJsonValue,
  systemClock
} from "@vivd-catalyst/core";
import {
  isModelProviderContinuationRejected,
  type ModelCompletion,
  type ModelMessage,
  type ModelProvider,
  type ModelToolCall
} from "@vivd-catalyst/model-provider";
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
  orderApprovalDecisionsForModel,
  readAssistantProviderContinuation,
  selectRecentCompleteHistory,
  stableStringify,
  type ModelOutputProjection,
  type ModelContextArtifactReader,
  type ModelContextFileReader,
  type ModelContextProjectionOptions,
  type StoredReasoningSummary
} from "./model-context-projection";
import {
  applyModelInputImageBudget,
  MODEL_INPUT_IMAGES_MAX_BYTES
} from "./model-input-image-budget";
import { materializeModelTools, type ModelToolRegistryView } from "./model-tool-materialization";

export interface ModelCallGovernance extends ModelUsageRecorder {
  runModelCall<T>(clientInstanceId: ClientInstanceId, execute: () => Promise<T>): Promise<T>;
}

export interface LocalAgentRuntimeOptions {
  logger?: import("@vivd-catalyst/core").Logger;
  assetSource: ConfigAssetSource;
  modelProviders: ModelProviderConfig[];
  modelBindings?: readonly ModelBindingConfig[];
  defaultModelProvider: ModelProviderConfig;
  conversationHistory: ConversationHistoryStore;
  modelProviderContinuationStore?: ModelProviderContinuationStore;
  agentRunStore?: AgentRunStore;
  runObservationStore?: RunObservationStore;
  modelProvider: ModelProvider;
  toolRegistry: ModelToolRegistryView;
  toolExecution: ToolExecution;
  usageGovernance: ModelCallGovernance;
  webAccess?: WebAccessConfig;
  agentSkillChangesEnabled?: boolean;
  historyMessageLimit?: number;
  maxSteps?: number;
  repeatedToolCallLimit?: number;
  modelContext?: ModelContextProjectionOptions;
  artifactReader?: ModelContextArtifactReader;
  clock?: Clock;
  fileReader?: ModelContextFileReader;
  runFailureReporter?: (report: LocalAgentRunFailureReport) => void | Promise<void>;
  beforeEffect?: (effect: LocalAgentRuntimeEffect) => void | Promise<void>;
}

export interface LocalAgentRuntimeEffect {
  kind: "provider_request" | "assistant_message" | "tool_dispatch" | "tool_result_message";
  runId: AgentRunId;
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
// Protects a run from a provider's server error or dropped connection: the wait before the
// second and the third attempt. After the third attempt the run fails with the provider's error.
const MODEL_PROVIDER_RETRY_WAITS_MS = [1_000, 4_000];
// Protects a run from a provider's per-minute rate limit, which the short waits above cannot
// outlast: all waits of one model call on a rate limit add up to at most this. Then the run
// fails and the user reads that the model is receiving too many requests.
const MODEL_PROVIDER_RATE_LIMIT_WAIT_TOTAL_MS = 60_000;
// The first wait on a rate limit that names no pause in `Retry-After`; each later one doubles.
const MODEL_PROVIDER_RATE_LIMIT_FIRST_WAIT_MS = 4_000;
// Each wait varies by this share in both directions, so runs that failed together do not retry together.
const MODEL_PROVIDER_RETRY_JITTER_RATIO = 0.2;
// Protects a run from waiting on a provider that asks for a long pause in `Retry-After` on an
// error other than a rate limit. A shorter pause replaces the fixed wait; a longer one fails the
// run with the provider's error.
const MODEL_PROVIDER_RETRY_AFTER_MAX_MS = 60_000;
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
    if (
      !options.modelProviderContinuationStore &&
      options.modelProviders.some(
        (provider) => getProviderCompactionThreshold(provider) !== undefined
      )
    ) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Model provider compaction requires a model provider continuation store"
      );
    }
    this.options = options;
  }

  async start(input: StartAgentRunInput, context: RuntimeCallContext): Promise<AgentRunHandle> {
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

  holdsRun(runId: AgentRunId): boolean {
    return this.runs.has(runId);
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
      await this.beforeEffect("assistant_message", runId);
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
    const state = this.getRun(runId);
    const assets = await this.options.assetSource.getSnapshot();
    const agent = getSnapshotAgentConfig(assets, input.agentName);
    const modelSelection = this.getModelSelectionForAgent(
      agent,
      input.modelBindingId,
      input.reasoningEffort
    );
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
    const systemMessage: ModelMessage = {
      role: "system",
      content: createSystemInstructions(agent.instructions, context.locale, {
        currentDate: this.options.clock?.now() ?? systemClock.now(),
        skills: getSnapshotSkillMetadataForAgent(assets, agent),
        agentToolNames: agent.toolNames,
        agentSkillChangesEnabled: this.options.agentSkillChangesEnabled
      })
    };
    const userMessage: ModelMessage = { role: "user", content: userContent };
    let messages: ModelMessage[] = [systemMessage, ...history.messages, userMessage];

    const repeatedToolCalls = new Map<string, number>();
    const maxSteps = agent.maxSteps ?? this.options.maxSteps ?? DEFAULT_MAX_STEPS;
    let providerContinuation: ModelCompletion["continuation"] = history.providerContinuation;
    // True until the first answer: only then does a request carry a continuation from an earlier run.
    let carriesEarlierContinuation = providerContinuation !== undefined;
    let runCompacted = false;
    const callModel = () => {
      const withinImageBudget = applyModelInputImageBudget(messages);
      if (withinImageBudget.omittedImageCount > 0) {
        this.options.logger?.warn(
          {
            type: "model_input.images_omitted",
            runId,
            conversationId: input.conversationId,
            omittedImageCount: withinImageBudget.omittedImageCount,
            maxBytes: MODEL_INPUT_IMAGES_MAX_BYTES
          },
          "Older images left out of the model request"
        );
      }
      return this.withTransientModelRetry(context, state, (attempt) =>
        this.beforeEffect("provider_request", runId).then(() =>
          this.options.usageGovernance.runModelCall(context.clientInstanceId, () =>
            this.completeWithProvider(
              {
                providerId: modelSelection.provider.id,
                model: modelSelection.model,
                reasoningEffort: modelSelection.reasoningEffort,
                fastMode: modelSelection.fastMode,
                continuation: providerContinuation,
                messages: withinImageBudget.messages,
                tools
              },
              context,
              state,
              true,
              attempt
            )
          )
        )
      );
    };

    for (let step = 0; step < maxSteps; step += 1) {
      const modelResult = await callModel().catch(async (error: unknown) => {
        if (!carriesEarlierContinuation || !isModelProviderContinuationRejected(error)) {
          throw error;
        }
        // The provider can never accept this continuation, so every message of the conversation
        // would fail. Drop it and send the request once more from the conversation's history.
        carriesEarlierContinuation = false;
        await this.options.modelProviderContinuationStore?.deleteModelProviderContinuation({
          clientInstanceId: context.clientInstanceId,
          conversationId: input.conversationId,
          providerId: modelSelection.provider.id
        });
        this.options.logger?.warn(
          {
            type: "model_provider_continuation.dropped",
            runId,
            conversationId: input.conversationId,
            providerId: modelSelection.provider.id
          },
          "Model provider continuation dropped; request rebuilt from history"
        );
        const rebuilt = await this.loadModelHistory(input, context, modelSelection.provider, {
          withoutCheckpoint: true
        });
        providerContinuation = undefined;
        messages = [systemMessage, ...rebuilt.messages, userMessage];
        return callModel();
      });
      carriesEarlierContinuation = false;
      await recordModelUsage({
        usageStore: this.options.usageGovernance,
        runId,
        startInput: input,
        context,
        provider: modelSelection.provider,
        model: modelSelection.model,
        fastMode: modelSelection.fastMode,
        completion: modelResult.completion
      });
      const { completion, emittedDeltas, reasoning } = modelResult;
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
        if (context.signal?.aborted || isCancellationRequested(state.getStatus())) {
          return;
        }
        const assistantText = completion.text || completedWithoutTextFallback(context.locale);
        await this.beforeEffect("assistant_message", runId);
        const persisted = await this.options.conversationHistory.appendAssistantMessage({
          clientInstanceId: context.clientInstanceId,
          conversationId: input.conversationId,
          text: assistantText,
          metadata: createAssistantFinalMetadata({
            runId,
            reasoning,
            sources: completion.sources,
            citations: completion.citations,
            modelContext
          }),
          providerContinuation: persistedContinuation
        });
        if (emittedDeltas) {
          state.completeMessage(persisted);
        } else {
          state.message(persisted);
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
      await this.beforeEffect("assistant_message", runId);
      await this.options.conversationHistory.appendAssistantMessage({
        clientInstanceId: context.clientInstanceId,
        conversationId: input.conversationId,
        text: completion.text,
        metadata: createAssistantToolCallsMetadata({
          runId,
          toolCalls: completion.toolCalls,
          reasoning,
          modelContext
        }),
        providerContinuation: persistedContinuation
      });

      for (const toolCall of completion.toolCalls) {
        if (context.signal?.aborted) return;
        const result = await executeToolCall({
          runId,
          startInput: input,
          context,
          state,
          toolCall,
          toolExecution: this.options.toolExecution,
          modelContext: this.modelContextOptions(context),
          repeatedToolCall: this.registerToolCall(
            repeatedToolCalls,
            toolCall.input,
            toolCall.toolName
          ),
          beforeDispatch: () => this.beforeEffect("tool_dispatch", runId)
        });
        if (isCancellationRequested(state.getStatus())) {
          return;
        }
        await this.beforeEffect("tool_result_message", runId);
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

  private async beforeEffect(kind: LocalAgentRuntimeEffect["kind"], runId: AgentRunId) {
    await this.options.beforeEffect?.({ kind, runId });
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

  private getModelSelectionForAgent(
    agent: AgentConfig,
    userSelectedBindingId?: string,
    userSelectedReasoningEffort?: ReasoningEffortConfig
  ): {
    provider: ModelProviderConfig;
    model: string;
    reasoningEffort?: ReasoningEffortConfig;
    fastMode: boolean;
  } {
    const bindingId = userSelectedBindingId ?? agent.modelBindingId;
    if (bindingId) {
      const binding = this.options.modelBindings?.find((candidate) => candidate.id === bindingId);
      if (!binding) {
        throw new AppError("NOT_FOUND", `Model binding '${bindingId}' is not defined`);
      }
      if (
        userSelectedBindingId &&
        !isModelBindingUserSelectableForAgent(
          agent,
          this.options.modelBindings ?? [],
          userSelectedBindingId
        )
      ) {
        throw new AppError(
          "VALIDATION_FAILED",
          `Model binding '${bindingId}' is not available for user selection with agent '${agent.name}'`
        );
      }
      const provider = this.getModelProvider(binding.providerId);
      const configuredEffort =
        defaultReasoningEffortForAgentBinding(agent, binding) ??
        (provider.type === "openai-compatible" ? provider.reasoningEffort : undefined);
      return {
        provider,
        model: binding.model ?? provider.model,
        // An effort the user picked wins while the binding still offers it; a pick the binding
        // no longer offers falls back to the configured effort instead of failing the run.
        reasoningEffort:
          userSelectedReasoningEffort &&
          reasoningEffortChoiceForBinding(binding, provider, configuredEffort).selectable.includes(
            userSelectedReasoningEffort
          )
            ? userSelectedReasoningEffort
            : configuredEffort,
        // A user-selected binding gets fast mode only when that binding supports it.
        fastMode: agent.fastMode === true && binding.supportsFastMode === true
      };
    }

    const provider = this.getModelProvider(
      agent.modelProviderId ?? this.options.defaultModelProvider.id
    );
    return {
      provider,
      model: provider.model,
      reasoningEffort:
        agent.reasoningEffort ??
        (provider.type === "openai-compatible" ? provider.reasoningEffort : undefined),
      fastMode: false
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
    provider: ModelProviderConfig,
    options: { withoutCheckpoint?: boolean } = {}
  ): Promise<{
    messages: ModelMessage[];
    providerContinuation?: ModelCompletion["continuation"];
  }> {
    const persistedMessages = await this.options.conversationHistory.listMessages({
      clientInstanceId: context.clientInstanceId,
      conversationId: input.conversationId
    });
    const history = orderApprovalDecisionsForModel(
      dropCurrentSubmittedMessage(persistedMessages, input.message.text, input.inputMessageId)
    );
    const compactionEnabled = getProviderCompactionThreshold(provider) !== undefined;
    if (options.withoutCheckpoint) {
      // What a conversation that never compacted sends: all of its history, no continuation.
      return {
        messages: await projectAgentVisibleHistory(
          compactionEnabled
            ? history
            : selectRecentCompleteHistory(
                history,
                this.options.historyMessageLimit ?? DEFAULT_CONVERSATION_HISTORY_LIMIT
              ),
          this.modelContextOptions(context)
        )
      };
    }
    const storedCheckpoint = compactionEnabled
      ? await this.options.modelProviderContinuationStore?.getModelProviderContinuation({
          clientInstanceId: context.clientInstanceId,
          conversationId: input.conversationId,
          providerId: provider.id
        })
      : undefined;
    const storedCheckpointIndex = storedCheckpoint
      ? history.findIndex((message) => message.id === storedCheckpoint.sourceMessageId)
      : -1;
    const legacyCheckpointIndex = compactionEnabled
      ? findLatestCompactionCheckpointIndex(history, provider.id)
      : -1;
    const checkpointIndex = Math.max(storedCheckpointIndex, legacyCheckpointIndex);
    const legacyCheckpoint =
      legacyCheckpointIndex >= 0
        ? readAssistantProviderContinuation(history[legacyCheckpointIndex]?.metadata)
        : undefined;
    const checkpoint =
      storedCheckpoint &&
      storedCheckpointIndex >= legacyCheckpointIndex &&
      storedCheckpointIndex >= 0
        ? {
            providerId: storedCheckpoint.providerId,
            state: storedCheckpoint.state
          }
        : legacyCheckpoint;
    const activeHistory = compactionEnabled
      ? history.slice(Math.max(checkpointIndex, 0))
      : selectRecentCompleteHistory(
          history,
          this.options.historyMessageLimit ?? DEFAULT_CONVERSATION_HISTORY_LIMIT
        );
    return {
      messages: await projectAgentVisibleHistory(activeHistory, this.modelContextOptions(context)),
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
      logger: this.options.logger,
      fileReader: this.options.fileReader
    };
  }

  private async completeWithProvider(
    request: Parameters<ModelProvider["complete"]>[0],
    context: RuntimeCallContext,
    state: RunState,
    streamText: boolean,
    attempt: ModelProviderAttempt
  ): Promise<{
    completion: ModelCompletion;
    emittedDeltas: boolean;
    reasoning: StoredReasoningSummary[];
  }> {
    if (!streamText || !this.options.modelProvider.stream) {
      const completion = await this.options.modelProvider.complete(request, context);
      attempt.retrySafe = false;
      return {
        completion,
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
          attempt.retrySafe = false;
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
          attempt.retrySafe = false;
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
        const toolCallId = asToolCallId(event.toolCallId);
        attempt.preparingToolCallIds.push(toolCallId);
        state.emit({
          type: "tool_call_preparing",
          runId: state.runId,
          toolCallId,
          toolName: event.toolName
        });
        continue;
      }
      if (event.type === "provider_tool_started") {
        attempt.retrySafe = false;
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
        attempt.retrySafe = false;
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
      attempt.retrySafe = false;
      completion = event.completion;
    }

    if (!completion) {
      throw new AppError("INTERNAL", "Model provider stream ended without a completion");
    }

    const unstreamedText = getUnstreamedCompletionText(
      completion.text,
      streamedText,
      emittedDeltas
    );
    if (unstreamedText.length > 0) {
      attempt.retrySafe = false;
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

  private async withTransientModelRetry<T>(
    context: RuntimeCallContext,
    state: RunState,
    execute: (attempt: ModelProviderAttempt) => Promise<T>
  ): Promise<T> {
    let transientFailures = 0;
    let rateLimitFailures = 0;
    let rateLimitWaitLeftMs = MODEL_PROVIDER_RATE_LIMIT_WAIT_TOTAL_MS;
    for (;;) {
      if (context.signal?.aborted) {
        throw new AppError(
          "CONFLICT",
          "Agent run was stopped before the model provider was called"
        );
      }
      if (context.deadline && Date.now() >= context.deadline.getTime()) {
        throw new AppError(
          "TIMEOUT",
          "Agent run deadline passed before the model provider was called"
        );
      }
      const progress: ModelProviderAttempt = { retrySafe: true, preparingToolCallIds: [] };
      try {
        return await execute(progress);
      } catch (error) {
        const failure = rateLimitFailureFor(error);
        if (
          !progress.retrySafe ||
          context.signal?.aborted ||
          !isTransientModelProviderError(error)
        ) {
          throw failure;
        }
        const retryAfterMs = readRetryAfterMs(error);
        let waitMs: number;
        if (failure !== error) {
          rateLimitFailures += 1;
          // Never sooner than the provider asks, and never past what is left of the minute.
          waitMs = Math.min(
            Math.max(retryAfterMs ?? 0, modelProviderRateLimitWaitMs(rateLimitFailures)),
            rateLimitWaitLeftMs
          );
          if (waitMs <= 0 || (retryAfterMs ?? 0) > rateLimitWaitLeftMs) {
            throw failure;
          }
          rateLimitWaitLeftMs -= waitMs;
        } else {
          transientFailures += 1;
          if (transientFailures > MODEL_PROVIDER_RETRY_WAITS_MS.length) {
            throw failure;
          }
          waitMs = retryAfterMs ?? modelProviderRetryWaitMs(transientFailures);
          if (waitMs > MODEL_PROVIDER_RETRY_AFTER_MAX_MS) {
            throw failure;
          }
        }
        if (context.deadline && Date.now() + waitMs >= context.deadline.getTime()) {
          throw failure;
        }
        for (const toolCallId of progress.preparingToolCallIds) {
          state.emit({
            type: "tool_call_preparation_cancelled",
            runId: state.runId,
            toolCallId
          });
        }
        try {
          await waitUnlessAborted(waitMs, context.signal);
        } catch {
          throw failure;
        }
      }
    }
  }
}

interface ModelProviderAttempt {
  retrySafe: boolean;
  preparingToolCallIds: ReturnType<typeof asToolCallId>[];
}

/** Rejects when the signal aborts first. Uses the global timer so a test clock can drive it. */
function waitUnlessAborted(waitMs: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Model provider retry wait was cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, waitMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function modelProviderRetryWaitMs(failedAttempt: number): number {
  return withRetryJitter(MODEL_PROVIDER_RETRY_WAITS_MS[failedAttempt - 1] ?? 0);
}

function modelProviderRateLimitWaitMs(failedAttempt: number): number {
  return withRetryJitter(MODEL_PROVIDER_RATE_LIMIT_FIRST_WAIT_MS * 2 ** (failedAttempt - 1));
}

function withRetryJitter(waitMs: number): number {
  return Math.round(waitMs * (1 + (Math.random() * 2 - 1) * MODEL_PROVIDER_RETRY_JITTER_RATIO));
}

/**
 * What a run fails with: the error itself, or for a provider's rate limit (HTTP 429, or the same
 * refusal inside a stream) an error whose message the user may read.
 */
function rateLimitFailureFor(error: unknown): unknown {
  let candidate = error;
  for (let depth = 0; depth < 4 && candidate instanceof Error; depth += 1) {
    const details =
      candidate instanceof AppError && isRecord(candidate.details) ? candidate.details : undefined;
    if (details?.status === 429) {
      const failure = new AppError(
        "RATE_LIMITED",
        "The model is receiving too many requests. Try again in a minute."
      );
      failure.cause = error;
      return failure;
    }
    candidate = candidate.cause;
  }
  return error;
}

/** The pause a provider asked for with its refusal, read from the error or what caused it. */
function readRetryAfterMs(error: unknown): number | undefined {
  let candidate = error;
  for (let depth = 0; depth < 4 && candidate instanceof Error; depth += 1) {
    const details =
      candidate instanceof AppError && isRecord(candidate.details) ? candidate.details : undefined;
    if (typeof details?.retryAfterMs === "number" && details.retryAfterMs >= 0) {
      return details.retryAfterMs;
    }
    candidate = candidate.cause;
  }
  return undefined;
}

function isTransientModelProviderError(error: unknown): boolean {
  let candidate = error;
  for (let depth = 0; depth < 4 && candidate; depth += 1) {
    if (candidate instanceof AppError) {
      if (candidate.code === "TIMEOUT") {
        return true;
      }
      const details = isRecord(candidate.details) ? candidate.details : undefined;
      const status = typeof details?.status === "number" ? details.status : undefined;
      if (status === 408 || status === 429 || (status !== undefined && status >= 500)) {
        return true;
      }
    }
    if (candidate instanceof Error) {
      const code = readErrorCode(candidate);
      if (
        code === "ECONNRESET" ||
        code === "ECONNREFUSED" ||
        code === "EPIPE" ||
        code === "ETIMEDOUT" ||
        code === "UND_ERR_SOCKET"
      ) {
        return true;
      }
      if (/\b(?:fetch failed|socket hang up|terminated|timed out)\b/iu.test(candidate.message)) {
        return true;
      }
      candidate = candidate.cause;
      continue;
    }
    break;
  }
  return false;
}

function readErrorCode(error: Error): string | undefined {
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCancellationRequested(status: AgentRunStatus): boolean {
  return status === "cancelling" || status === "cancelled";
}

function getProviderCompactionThreshold(provider: ModelProviderConfig): number | undefined {
  return provider.type === "openai-compatible"
    ? provider.contextManagement?.compaction?.compactThresholdTokens
    : undefined;
}

function findLatestCompactionCheckpointIndex(messages: ChatMessage[], providerId: string): number {
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
