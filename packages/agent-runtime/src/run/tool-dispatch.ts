import type {
  AgentRunId,
  ChatMessage,
  RuntimeCallContext,
  StartAgentRunInput,
  ToolExecutionResult
} from "@vivd-catalyst/core";
import type { ModelMessage, ModelToolCall } from "@vivd-catalyst/model-provider";
import { executeToolCall } from "../tool-call-execution";
import {
  createToolResultMetadata,
  stableStringify,
  type ModelOutputProjection
} from "../model-context-projection";
import type { RunState } from "../run-state";
import { isCancellationRequested } from "./run-events";
import type { ModelInput } from "./model-input";
import type { RunEvents } from "./run-events";
import type { LocalAgentRuntimeOptions } from "./run-events";

const DEFAULT_REPEATED_TOOL_CALL_LIMIT = 3;

export class ToolDispatch {
  constructor(
    private readonly options: LocalAgentRuntimeOptions,
    private readonly modelInput: ModelInput,
    private readonly runEvents: RunEvents
  ) {}

  async dispatchToolCalls(
    runId: AgentRunId,
    input: StartAgentRunInput,
    context: RuntimeCallContext,
    state: RunState,
    toolCalls: ModelToolCall[],
    repeatedToolCalls: Map<string, number>,
    messages: ModelMessage[]
  ): Promise<boolean> {
    for (const toolCall of toolCalls) {
      if (context.signal?.aborted) return true;
      const result = await executeToolCall({
        runId,
        startInput: input,
        context,
        state,
        toolCall,
        toolExecution: this.options.toolExecution,
        modelContext: this.modelInput.modelContextOptions(context),
        repeatedToolCall: this.registerToolCall(
          repeatedToolCalls,
          toolCall.input,
          toolCall.toolName
        ),
        beforeDispatch: () => this.runEvents.beforeEffect("tool_dispatch", runId)
      });
      if (isCancellationRequested(state.getStatus())) {
        return true;
      }
      await this.runEvents.beforeEffect("tool_result_message", runId);
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
    return false;
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
}
