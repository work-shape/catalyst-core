import {
  type AgentRunId,
  type RuntimeCallContext,
  type StartAgentRunInput,
  type ToolDecisionWait,
  type ToolExecutionResult,
  type ToolOperationRunner,
  asToolCallId
} from "@work-shape/catalyst-core";
import type { ModelToolCall } from "@work-shape/catalyst-model-provider";
import {
  createModelVisibleToolOutput,
  type ModelContextProjectionOptions,
  type ModelOutputProjection
} from "./model-context-projection";
import type { RunState } from "./run-state";

export async function executeToolCall(input: {
  runId: AgentRunId;
  startInput: StartAgentRunInput;
  context: RuntimeCallContext;
  state: RunState;
  toolCall: ModelToolCall;
  /** Runs the call as the operation the tool is. Every check of the call is on that path. */
  runTool: ToolOperationRunner;
  /**
   * Set for a call of a data tool the run was not offered when it started. It is answered as
   * a failure the agent reads, and nothing is run.
   */
  unoffered?: boolean;
  modelContext: ModelContextProjectionOptions;
  repeatedToolCall: {
    repeated: boolean;
    count: number;
    limit: number;
  };
  beforeDispatch?: () => void | Promise<void>;
}): Promise<
  | { result: ToolExecutionResult; modelOutput: ModelOutputProjection }
  | { waiting: ToolDecisionWait }
> {
  const toolCallId = asToolCallId(input.toolCall.toolCallId);
  input.state.emit({
    type: "tool_call_started",
    runId: input.runId,
    toolCallId,
    toolName: input.toolCall.toolName,
    input: input.toolCall.input
  });

  const request = {
    toolName: input.toolCall.toolName,
    toolCallId,
    agentRunId: input.runId,
    conversationId: input.startInput.conversationId,
    agentName: input.startInput.agentName,
    input: input.toolCall.input
  };

  if (input.unoffered) {
    const result = {
      status: "failed" as const,
      error: {
        code: "not_allowed" as const,
        message: `Tool '${input.toolCall.toolName}' is not available in this run`
      }
    };
    const modelOutput = await createModelVisibleToolOutput(result, input.modelContext);
    input.state.emit({
      type: "tool_call_failed",
      runId: input.runId,
      toolCallId,
      toolName: input.toolCall.toolName,
      result,
      modelOutput: modelOutput.text,
      projectionNotice: modelOutput.notice
    });
    return { result, modelOutput };
  }

  if (input.repeatedToolCall.repeated) {
    const result = {
      status: "failed" as const,
      error: {
        code: "repeated_tool_call" as const,
        message: `Repeated identical tool call '${input.toolCall.toolName}' reached the configured limit of ${input.repeatedToolCall.limit}`,
        details: {
          count: input.repeatedToolCall.count,
          limit: input.repeatedToolCall.limit
        }
      }
    };
    const modelOutput = await createModelVisibleToolOutput(result, input.modelContext);
    input.state.emit({
      type: "tool_call_failed",
      runId: input.runId,
      toolCallId,
      toolName: input.toolCall.toolName,
      result,
      modelOutput: modelOutput.text,
      projectionNotice: modelOutput.notice
    });
    return { result, modelOutput };
  }

  await input.beforeDispatch?.();
  // The surface is asked before the input is read, so a call the agent may not make is
  // refused as that and not for its input.
  const answer = await input.runTool(request, input.context, {
    unreadableInput: input.toolCall.inputParseError && {
      code: input.toolCall.inputParseError.code,
      message: input.toolCall.inputParseError.message
    }
  });
  // The call waits for a decision: it has not run, and the run pauses on it.
  if (answer.status === "waiting_for_decision") {
    return { waiting: answer };
  }
  return emitToolCallEnd(input, answer);
}

/** Answers the agent what a call came to, with the event that ends the call. */
export async function emitToolCallEnd(
  input: {
    modelContext: ModelContextProjectionOptions;
    runId: AgentRunId;
    startInput: StartAgentRunInput;
    state: RunState;
    toolCall: ModelToolCall;
  },
  result: ToolExecutionResult
): Promise<{ result: ToolExecutionResult; modelOutput: ModelOutputProjection }> {
  const toolCallId = asToolCallId(input.toolCall.toolCallId);
  const modelOutput = await createModelVisibleToolOutput(result, input.modelContext);
  logProjectionNotice(input, modelOutput);
  input.state.emit({
    type: result.status === "success" ? "tool_call_completed" : "tool_call_failed",
    runId: input.runId,
    toolCallId,
    toolName: input.toolCall.toolName,
    result,
    modelOutput: modelOutput.text,
    projectionNotice: modelOutput.notice
  });

  return { result, modelOutput };
}

function logProjectionNotice(
  input: {
    modelContext: ModelContextProjectionOptions;
    runId: AgentRunId;
    startInput: StartAgentRunInput;
    toolCall: ModelToolCall;
  },
  modelOutput: ModelOutputProjection
): void {
  if (!modelOutput.notice) {
    return;
  }
  input.modelContext.logger?.warn(
    {
      type: "model_context_projection.bounded_tool_output",
      runId: input.runId,
      conversationId: input.startInput.conversationId,
      toolCallId: input.toolCall.toolCallId,
      toolName: input.toolCall.toolName,
      ...modelOutput.notice
    },
    "Model context tool output bounded"
  );
}
