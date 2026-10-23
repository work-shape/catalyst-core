import { WEB_FETCH_TOOL_NAME } from "@work-shape/catalyst-web-access";
import { forbiddenPreviewTool, parseConnectionOperationName } from "@work-shape/catalyst-core";
import type {
  AgentRunId,
  ChatMessage,
  RuntimeCallContext,
  StartAgentRunInput,
  StartedSubagent,
  ToolDecisionWait,
  ToolExecutionError,
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
import { isRunAgentCall, stepLimitRefusal } from "./subagents";

const DEFAULT_REPEATED_TOOL_CALL_LIMIT = 3;

/**
 * How the calls of one step went: all through, the run stopped, or a call waits for a
 * decision. Calls run in order, so the calls after a waiting one have not started (S7). A
 * `run_agent` call that started its subagent is not answered here: it is in `subagents`, and
 * answered once the step's calls are through and its subagent ended.
 */
export type ToolDispatchOutcome =
  | { kind: "answered"; subagents: StartedSubagent[] }
  | { kind: "stopped" }
  | {
      kind: "paused";
      toolCall: ModelToolCall;
      waiting: ToolDecisionWait;
      /** The calls this dispatch answered before the waiting one. */
      answeredToolCallIds: string[];
      subagents: StartedSubagent[];
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
    offeredDataTools: ReadonlySet<string>,
    /** The subagents the step started before these calls, which count to the step's limit. */
    startedInStep = 0
  ): Promise<ToolDispatchOutcome> {
    const answeredToolCallIds: string[] = [];
    const subagents: StartedSubagent[] = [];
    for (const toolCall of toolCalls) {
      if (context.signal?.aborted) return { kind: "stopped" };
      const webRefusal = await this.webFetchRefusal(runId, toolCall.toolName, state, input);
      const refusal =
        webRefusal ??
        (isRunAgentCall(toolCall.toolName)
          ? stepLimitRefusal(startedInStep + subagents.length)
          : undefined);
      const result = await executeToolCall({
        runId,
        startInput: input,
        context,
        state,
        toolCall,
        runTool: this.options.runTool,
        unoffered:
          isUnofferedDataToolCall(toolCall.toolName, offeredDataTools) ||
          Boolean(input.preview && forbiddenPreviewTool(toolCall.toolName)),
        ...(refusal ? { refusal } : {}),
        modelContext: this.modelInput.modelContextOptions(context),
        repeatedToolCall: this.registerToolCall(
          repeatedToolCalls,
          toolCall.input,
          toolCall.toolName
        ),
        beforeDispatch: async () => {
          await this.runEvents.beforeEffect("tool_dispatch", runId);
          await this.beforePersonalCall(toolCall.toolName, state);
        }
      });
      if (isCancellationRequested(state.getStatus())) {
        return { kind: "stopped" };
      }
      if ("waiting" in result) {
        return {
          kind: "paused",
          toolCall,
          waiting: result.waiting,
          answeredToolCallIds,
          subagents
        };
      }
      if ("subagent" in result) {
        subagents.push(result.subagent);
        continue;
      }
      await this.answerToolCall(runId, input, context, toolCall, result, messages);
      answeredToolCallIds.push(toolCall.toolCallId);
    }
    return { kind: "answered", subagents };
  }

  async webFetchRefusal(
    runId: AgentRunId,
    toolName: string,
    state: RunState,
    input: StartAgentRunInput
  ): Promise<ToolExecutionError | undefined> {
    return toolName === WEB_FETCH_TOOL_NAME &&
      (await this.modelInput.webAccessOff(runId, state, input))
      ? {
          code: "not_allowed",
          message:
            "Web access is off in this conversation because it holds data from a personal connection"
        }
      : undefined;
  }

  /** Set before dispatch, independent of validation, authorization or the call's outcome. */
  async beforePersonalCall(toolName: string, state: RunState): Promise<void> {
    if (
      parseConnectionOperationName(toolName) &&
      (await this.options.personalData?.operations.resolve(toolName))?.personalConnection
    ) {
      state.disableWebAccess();
    }
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
