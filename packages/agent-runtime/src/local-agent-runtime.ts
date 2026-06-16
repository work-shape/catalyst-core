import {
  AppError,
  type AgentConfig,
  type AgentRunHandle,
  type AgentRunId,
  type AgentRuntime,
  type AgentRuntimeCommand,
  type AgentRuntimeEvent,
  type ChatMessage,
  type ConversationHistoryStore,
  type ModelProviderConfig,
  type RuntimeCallContext,
  type StartAgentRunInput,
  type ToolExecution,
  type ToolExecutionResult,
  asAgentRunId,
  createPlatformId
} from "@vivd-catalyst/core";
import type { ModelCompletion, ModelMessage, ModelProvider, ModelToolCall } from "@vivd-catalyst/model-provider";
import type { ToolRegistry } from "@vivd-catalyst/tool-execution";
import type { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import { RunState } from "./run-state";
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
  selectRecentCompleteHistory,
  stableStringify,
  type ModelOutputProjection,
  type ModelContextArtifactReader,
  type ModelContextProjectionOptions,
  type StoredReasoningSummary
} from "./model-context-projection";

export interface LocalAgentRuntimeOptions {
  agents: AgentConfig[];
  modelProviders: ModelProviderConfig[];
  defaultModelProvider: ModelProviderConfig;
  conversationHistory: ConversationHistoryStore;
  modelProvider: ModelProvider;
  toolRegistry: ToolRegistry;
  toolExecution: ToolExecution;
  usageGovernance: ModelUsageGovernance;
  historyMessageLimit?: number;
  maxSteps?: number;
  repeatedToolCallLimit?: number;
  modelContext?: ModelContextProjectionOptions;
  artifactReader?: ModelContextArtifactReader;
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

  constructor(options: LocalAgentRuntimeOptions) {
    this.options = options;
  }

  async start(
    input: StartAgentRunInput,
    context: RuntimeCallContext
  ): Promise<AgentRunHandle> {
    const runId = createPlatformId<"AgentRunId">("run");
    const state = new RunState(runId);
    this.runs.set(runId, state);

    queueMicrotask(() => {
      void this.executeRun(runId, input, context).catch((error) => {
        state.fail(error);
      });
    });

    return {
      runId,
      status: "running",
      startedAt: state.startedAt
    };
  }

  observe(runId: AgentRunId): AsyncIterable<AgentRuntimeEvent> {
    const state = this.getRun(runId);
    return state.observe();
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
    _context: RuntimeCallContext
  ): Promise<void> {
    const state = this.getRun(runId);
    state.cancel(reason);
  }

  private async executeRun(
    runId: AgentRunId,
    input: StartAgentRunInput,
    context: RuntimeCallContext
  ): Promise<void> {
    const state = this.getRun(runId);
    const agent = this.getAgentConfig(input.agentName);
    const provider = this.getModelProviderForAgent(agent);
    const tools = this.options.toolRegistry.listDescriptorsForAgent(agent.toolNames);
    const historyMessages = await this.loadModelHistory(input, context);
    const userContent = createSubmittedUserMessageContent(
      input.message.text,
      input.message.attachmentManifest
    );
    const messages: ModelMessage[] = [
      { role: "system", content: createSystemInstructions(agent.instructions, tools.length, context.locale) },
      ...historyMessages,
      { role: "user", content: userContent }
    ];

    const repeatedToolCalls = new Map<string, number>();
    const maxSteps = agent.maxSteps ?? this.options.maxSteps ?? DEFAULT_MAX_STEPS;

    for (let step = 0; step < maxSteps; step += 1) {
      const { completion, emittedDeltas, reasoning } = await this.options.usageGovernance.runModelCall(
        context.clientInstanceId,
        async () => {
          const modelResult = await this.completeWithProvider(
            {
              providerId: provider.id,
              model: provider.model,
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
            provider,
            completion: modelResult.completion
          });
          return modelResult;
        }
      );

      if (completion.toolCalls.length === 0) {
        const assistantText = completion.text || "I completed the request.";
        const persisted = await this.options.conversationHistory.appendMessage({
          clientInstanceId: context.clientInstanceId,
          conversationId: input.conversationId,
          role: "assistant",
          text: assistantText,
          metadata: createAssistantFinalMetadata({ runId, reasoning })
        });
        if (emittedDeltas) {
          state.completeMessage(persisted);
        } else {
          state.message(persisted);
        }
        state.complete();
        return;
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
          reasoning
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

  private getRun(runId: AgentRunId): RunState {
    const state = this.runs.get(runId);
    if (!state) {
      throw new AppError("NOT_FOUND", `Agent run '${runId}' was not found`);
    }
    return state;
  }

  private getAgentConfig(agentName: string): AgentConfig {
    const agent = this.options.agents.find((candidate) => candidate.name === agentName);
    if (!agent) {
      throw new AppError("NOT_FOUND", `Agent '${agentName}' is not defined`);
    }
    return agent;
  }

  private getModelProviderForAgent(agent: AgentConfig): ModelProviderConfig {
    const providerId = agent.modelProviderId ?? this.options.defaultModelProvider.id;
    const provider = this.options.modelProviders.find((candidate) => candidate.id === providerId);
    if (!provider) {
      throw new AppError("NOT_FOUND", `Model provider '${providerId}' is not defined`);
    }
    return provider;
  }

  private async loadModelHistory(
    input: StartAgentRunInput,
    context: RuntimeCallContext
  ): Promise<ModelMessage[]> {
    const persistedMessages = await this.options.conversationHistory.listMessages({
      clientInstanceId: context.clientInstanceId,
      conversationId: input.conversationId
    });
    const activeHistory = selectRecentCompleteHistory(
      dropCurrentSubmittedMessage(persistedMessages, input.message.text),
      this.options.historyMessageLimit ?? DEFAULT_CONVERSATION_HISTORY_LIMIT
    );
    return projectAgentVisibleHistory(
      activeHistory,
      this.modelContextOptions(context)
    );
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
      artifactReader: this.options.artifactReader
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
