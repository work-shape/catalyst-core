import {
  AppError,
  type AgentRunId,
  type ApprovedToolExecutionRequest,
  type RuntimeCallContext,
  type StartAgentRunInput,
  type ToolAuthorizationDecision,
  type ToolExecution,
  type ToolExecutionResult,
  asToolCallId
} from "@vivd-catalyst/core";
import type { ModelToolCall } from "@vivd-catalyst/model-provider";
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
  toolExecution: ToolExecution;
  modelContext: ModelContextProjectionOptions;
  repeatedToolCall: {
    repeated: boolean;
    count: number;
    limit: number;
  };
}): Promise<{
  result: ToolExecutionResult;
  modelOutput: ModelOutputProjection;
}> {
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

  const decision = await input.toolExecution.authorize(request, input.context);
  if (decision.status === "denied") {
    const result = {
      status: "failed" as const,
      error: {
        code: "not_allowed" as const,
        message: decision.reason
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

  if (input.toolCall.inputParseError) {
    const result = {
      status: "failed" as const,
      error: {
        code: "validation_failed" as const,
        message: input.toolCall.inputParseError.message,
        details: {
          issues: [
            {
              code: input.toolCall.inputParseError.code,
              path: "",
              message: input.toolCall.inputParseError.message
            }
          ]
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

  if (decision.status === "requires_approval") {
    input.state.emit({
      type: "tool_permission_requested",
      runId: input.runId,
      toolCallId,
      toolName: input.toolCall.toolName,
      reason: decision.reason,
      preview: decision.preview
    });
    throw new AppError(
      "CONFLICT",
      "Tool approval is required, but this v1 request path does not resume paused runs"
    );
  }

  const result = await input.toolExecution.execute(
    createApprovedToolRequest(request, decision),
    input.context
  );
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
    runId: AgentRunId;
    startInput: StartAgentRunInput;
    toolCall: ModelToolCall;
  },
  modelOutput: ModelOutputProjection
): void {
  if (!modelOutput.notice) {
    return;
  }
  console.warn(
    JSON.stringify({
      type: "model_context_projection.bounded_tool_output",
      runId: input.runId,
      conversationId: input.startInput.conversationId,
      toolCallId: input.toolCall.toolCallId,
      toolName: input.toolCall.toolName,
      ...modelOutput.notice
    })
  );
}

function createApprovedToolRequest(
  request: Omit<ApprovedToolExecutionRequest, "authorization">,
  authorization: Extract<ToolAuthorizationDecision, { status: "allowed" }>
): ApprovedToolExecutionRequest {
  return {
    ...request,
    authorization
  };
}
