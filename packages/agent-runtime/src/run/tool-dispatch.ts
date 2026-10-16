import type {
  AgentRunId,
  ChatMessage,
  RuntimeCallContext,
  StartAgentRunInput,
  ToolDecisionWait,
  ToolExecutionResult
} from "@work-shape/catalyst-core";
import type { ModelMessage, ModelToolCall } from "@work-shape/catalyst-model-provider";
import { executeToolCall } from "../tool-call-execution";
import { isUnofferedDataToolCall } from "../model-tool-materialization";
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

/**
 * How the calls of one step went: all answered, the run stopped, or a call waits for a
 * decision. Calls run in order, so the calls after a waiting one have not started (S7).
 */
export type ToolDispatchOutcome =
  | { kind: "answered" }
  | { kind: "stopped" }
  | {
      kind: "paused";
      toolCall: ModelToolCall;
      waiting: ToolDecisionWait;
      /** The calls this dispatch answered before the waiting one. */
      answeredToolCallIds: string[];
    };

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
    messages: ModelMessage[],
    /** The data tools the run was offered when it started. A call of another one is refused. */
    offeredDataTools: ReadonlySet<string>
  ): Promise<ToolDispatchOutcome> {
    const answeredToolCallIds: string[] = [];
    for (const toolCall of toolCalls) {
      if (context.signal?.aborted) return { kind: "stopped" };
      const result = await executeToolCall({
        runId,
        startInput: input,
        context,
        state,
        toolCall,
        runTool: this.options.runTool,
        unoffered: isUnofferedDataToolCall(toolCall.toolName, offeredDataTools),
        modelContext: this.modelInput.modelContextOptions(context),
        repeatedToolCall: this.registerToolCall(
          repeatedToolCalls,
          toolCall.input,
          toolCall.toolName
        ),
        beforeDispatch: () => this.runEvents.beforeEffect("tool_dispatch", runId)
      });
      if (isCancellationRequested(state.getStatus())) {
        return { kind: "stopped" };
      }
      if ("waiting" in result) {
        return { kind: "paused", toolCall, waiting: result.waiting, answeredToolCallIds };
      }
      await this.answerToolCall(runId, input, context, toolCall, result, messages);
      answeredToolCallIds.push(toolCall.toolCallId);
    }
    return { kind: "answered" };
  }

  /** Stores what a call came to and hands it to the model with the next request. */
  async answerToolCall(
    runId: AgentRunId,
    input: StartAgentRunInput,
    context: RuntimeCallContext,
    toolCall: ModelToolCall,
    answer: { result: ToolExecutionResult; modelOutput: ModelOutputProjection },
    messages: ModelMessage[]
  ): Promise<void> {
    await this.runEvents.beforeEffect("tool_result_message", runId);
    await this.persistToolResult({
      runId,
      input,
      context,
      toolCall,
      result: answer.result,
      modelOutput: answer.modelOutput
    });
    messages.push({
      role: "tool",
      toolCallId: toolCall.toolCallId,
      content: answer.modelOutput.content
    });
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
