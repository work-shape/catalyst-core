import type { ManagedArtifactRef, ToolDisplayOutput } from "./files";
import type { AuthenticatedIdentity } from "./identity";
import type {
  AgentRunId,
  CollaborationWorkspaceId,
  ConversationId,
  OperationRunId,
  ToolCallId
} from "./ids";
import type { StructuredResultPublication } from "./structured-result";
import type { ISODateString } from "./time";
import type { ToolExecutionRequest } from "./tool-execution";

export type OperationEffect = "reading" | "changing";

export type OperationOrigin =
  | {
      kind: "agent";
      agentRunId: AgentRunId;
      conversationId: ConversationId;
      agentName: string;
      toolCallId: ToolCallId;
      toolName: string;
    }
  | { kind: "user" }
  | { kind: "cli" }
  | { kind: "mcp"; clientName?: string }
  | {
      kind: "app";
      appRevisionId: string;
      actionName: string;
      pageSessionId: string;
      conversationId?: ConversationId;
    }
  | { kind: "workflow"; workflowRunId: string; stepRunId: string }
  | { kind: "schedule"; scheduleId: string };

export interface OperationCall<TInput = unknown> {
  operation: string;
  effect: OperationEffect;
  input: TInput;
  actor: AuthenticatedIdentity;
  origin: OperationOrigin;
  workspaceId?: CollaborationWorkspaceId;
  idempotencyKey?: string;
  correlationId: string;
}

export type OperationDenial =
  | {
      kind: "forbidden";
      action: string;
      reason: "no_grant" | "denied" | "unknown_action" | "holder_inactive";
    }
  | { kind: "policy"; operation: string }
  | { kind: "guardrail"; guardrailId: string; message?: string }
  | { kind: "declined"; by: string; comment?: string };

export type OperationResult<TOutput = unknown> =
  | {
      status: "done";
      runId: OperationRunId;
      output: TOutput;
      display?: ToolDisplayOutput;
      structuredResult?: StructuredResultPublication;
      artifacts?: ManagedArtifactRef[];
    }
  | {
      status: "pending_confirmation";
      runId: OperationRunId;
      expiresAt: ISODateString;
      preview: unknown;
      inputHash: string;
    }
  | {
      status: "pending_approval";
      runId: OperationRunId;
      approvalRequestId: string;
      expiresAt: ISODateString;
    }
  | { status: "denied"; runId: OperationRunId; reason: OperationDenial }
  | {
      status: "failed";
      runId: OperationRunId;
      error: { code: string; message: string; details?: Record<string, unknown> };
    }
  | { status: "expired"; runId: OperationRunId };

export function operationCallFromToolRequest(input: {
  request: ToolExecutionRequest;
  actor: AuthenticatedIdentity;
  operation: string;
  effect: OperationEffect;
  correlationId: string;
  workspaceId?: CollaborationWorkspaceId;
  idempotencyKey?: string;
}): OperationCall {
  const { request, ...context } = input;
  return {
    ...context,
    input: request.input,
    origin: {
      kind: "agent",
      agentRunId: request.agentRunId,
      conversationId: request.conversationId,
      agentName: request.agentName,
      toolCallId: request.toolCallId,
      toolName: request.toolName
    }
  };
}

export function toolRequestFromOperationCall(
  call: OperationCall & { origin: Extract<OperationOrigin, { kind: "agent" }> }
): ToolExecutionRequest {
  return {
    toolName: call.origin.toolName,
    toolCallId: call.origin.toolCallId,
    agentRunId: call.origin.agentRunId,
    conversationId: call.origin.conversationId,
    agentName: call.origin.agentName,
    input: call.input
  };
}
