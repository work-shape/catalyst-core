import {
  AppError,
  type AgentConfig,
  type AgentRunHandle,
  type AgentRunId,
  type AgentRuntime,
  type AgentRuntimeCommand,
  type AgentRuntimeEvent,
  type ChatMessage,
  type ConversationHistoryReader,
  type ModelProviderConfig,
  type RuntimeCallContext,
  type StartAgentRunInput,
  type ToolExecution,
  asAgentRunId,
  createPlatformId
} from "@agent-chat-platform/core";
import type { ModelCompletion, ModelMessage, ModelProvider } from "@agent-chat-platform/model-provider";
import type { ToolRegistry } from "@agent-chat-platform/tool-execution";
import type { ModelUsageGovernance } from "@agent-chat-platform/usage-governance";
import { RunState } from "./run-state";
import { createSystemInstructions } from "./system-instructions";
import { executeToolCall } from "./tool-call-execution";
import { recordModelUsage } from "./usage-recording";

export interface LocalAgentRuntimeOptions {
  agents: AgentConfig[];
  modelProviders: ModelProviderConfig[];
  defaultModelProvider: ModelProviderConfig;
  conversationHistory: ConversationHistoryReader;
  modelProvider: ModelProvider;
  toolRegistry: ToolRegistry;
  toolExecution: ToolExecution;
  usageGovernance: ModelUsageGovernance;
  historyMessageLimit?: number;
}

const DEFAULT_CONVERSATION_HISTORY_LIMIT = 20;

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
    const messages: ModelMessage[] = [
      { role: "system", content: createSystemInstructions(agent.instructions, tools.length, context.locale) },
      ...historyMessages,
      { role: "user", content: input.message.text }
    ];

    let emittedAssistantText = "";

    for (let round = 0; round < 4; round += 1) {
      const { completion, emittedDeltas } = await this.options.usageGovernance.runModelCall(
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
        const visibleAssistantText = `${emittedAssistantText}${assistantText}`;
        if (emittedDeltas) {
          state.completeMessage(visibleAssistantText);
        } else {
          state.message(visibleAssistantText);
        }
        state.complete();
        return;
      }

      if (emittedDeltas) {
        emittedAssistantText += completion.text;
      }

      messages.push({
        role: "assistant",
        content: completion.text,
        toolCalls: completion.toolCalls
      });

      for (const toolCall of completion.toolCalls) {
        const resultContent = await executeToolCall({
          runId,
          startInput: input,
          context,
          state,
          toolCall,
          toolExecution: this.options.toolExecution
        });
        messages.push({
          role: "tool",
          toolCallId: toolCall.toolCallId,
          content: resultContent
        });
      }
    }

    state.fail(new AppError("CONFLICT", "Agent exceeded the maximum tool-call rounds"));
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
    const recentMessages = await this.options.conversationHistory.listRecentMessages({
      clientInstanceId: context.clientInstanceId,
      conversationId: input.conversationId,
      limit: this.options.historyMessageLimit ?? DEFAULT_CONVERSATION_HISTORY_LIMIT
    });
    return dropCurrentSubmittedMessage(recentMessages, input.message.text)
      .map(toModelHistoryMessage)
      .filter((message): message is ModelMessage => message !== undefined);
  }

  private async completeWithProvider(
    request: Parameters<ModelProvider["complete"]>[0],
    context: RuntimeCallContext,
    state: RunState,
    streamText: boolean
  ): Promise<{ completion: ModelCompletion; emittedDeltas: boolean }> {
    if (!streamText || !this.options.modelProvider.stream) {
      return {
        completion: await this.options.modelProvider.complete(request, context),
        emittedDeltas: false
      };
    }

    let completion: ModelCompletion | undefined;
    let emittedDeltas = false;
    for await (const event of this.options.modelProvider.stream(request, context)) {
      if (event.type === "text_delta") {
        if (event.delta.length > 0) {
          emittedDeltas = true;
          state.emit({
            type: "message_delta",
            runId: state.runId,
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

    return {
      completion,
      emittedDeltas
    };
  }
}

export function asRuntimeRunId(value: string): AgentRunId {
  return asAgentRunId(value);
}

function dropCurrentSubmittedMessage(messages: ChatMessage[], text: string): ChatMessage[] {
  const lastMessage = messages.at(-1);
  if (lastMessage?.role === "user" && lastMessage.text === text) {
    return messages.slice(0, -1);
  }
  return messages;
}

function toModelHistoryMessage(message: ChatMessage): ModelMessage | undefined {
  if (message.role === "user" || message.role === "assistant") {
    return {
      role: message.role,
      content: message.text
    };
  }
  return undefined;
}
