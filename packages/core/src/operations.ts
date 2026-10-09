import type { OperationDenial } from "./operation-denial";
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

/**
 * The longest `Idempotency-Key` a caller may send, in characters. It protects the index the
 * key is looked up in. A longer key is refused with VALIDATION_FAILED naming this limit.
 */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

/** From the loosest to the strictest. Where several values meet, the strictest wins. */
export const POLICY_VALUES = ["allow", "confirm", "approval", "deny"] as const;

export type PolicyValue = (typeof POLICY_VALUES)[number];

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

/**
 * Whether the caller of this origin is present and the call is its own, so that the call
 * itself is the confirmation a `confirm` policy asks for. An agent, a workflow and a schedule
 * act for somebody who is not the caller.
 */
export function callerCanConfirm(origin: OperationOrigin): boolean {
  switch (origin.kind) {
    case "user":
    case "cli":
    case "mcp":
    case "app":
      return true;
    case "agent":
    case "workflow":
    case "schedule":
      return false;
  }
}

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
