import {
  AppError,
  type AgentRunId,
  type ApprovedToolExecutionRequest,
  type RuntimeCallContext,
  type StartAgentRunInput,
  type ToolAuthorizationDecision,
  type ToolExecution,
  asToolCallId
} from "@vivd-stage/core";
import type { ModelToolCall } from "@vivd-stage/model-provider";
import type { RunState } from "./run-state";

export async function executeToolCall(input: {
  runId: AgentRunId;
  startInput: StartAgentRunInput;
  context: RuntimeCallContext;
  state: RunState;
  toolCall: ModelToolCall;
  toolExecution: ToolExecution;
}): Promise<string> {
  const toolCallId = asToolCallId(input.toolCall.toolCallId);
  input.state.emit({
    type: "tool_call_started",
    runId: input.runId,
    toolCallId,
    toolName: input.toolCall.toolName
  });

  const request = {
    toolName: input.toolCall.toolName,
    toolCallId,
    agentRunId: input.runId,
    conversationId: input.startInput.conversationId,
    agentName: input.startInput.agentName,
    input: input.toolCall.input
  };
  const decision = await input.toolExecution.authorize(request, input.context);
  if (decision.status === "denied") {
    const result = {
      status: "failed" as const,
      error: {
        code: "not_allowed" as const,
        message: decision.reason
      }
    };
    input.state.emit({
      type: "tool_call_failed",
      runId: input.runId,
      toolCallId,
      toolName: input.toolCall.toolName,
      result
    });
    return JSON.stringify(result);
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
  input.state.emit({
    type: result.status === "success" ? "tool_call_completed" : "tool_call_failed",
    runId: input.runId,
    toolCallId,
    toolName: input.toolCall.toolName,
    result
  });

  if (result.status === "success") {
    return result.modelSummary ?? JSON.stringify(result.output);
  }

  return JSON.stringify(result.error);
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
