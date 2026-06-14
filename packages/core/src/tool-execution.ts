import type { AgentRunId, ConversationId, ToolCallId } from "./ids";
import type { JsonObject, JsonValue } from "./json";
import type { ISODateString } from "./time";
import type { AuditSafeSummary, ManagedArtifactRef, ToolDisplayOutput } from "./files";
import type { RuntimeCallContext } from "./identity";

export type ToolPermissionMode = "allow" | "deny" | "approval_required";

export interface ToolPermissionPolicy {
  mode: ToolPermissionMode;
  reason?: string;
  requiredPermissionRefs?: string[];
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputJsonSchema?: JsonObject;
  permission?: ToolPermissionPolicy;
}

export interface ToolExecutionRequest {
  toolName: string;
  toolCallId: ToolCallId;
  agentRunId: AgentRunId;
  conversationId: ConversationId;
  agentName: string;
  input: unknown;
}

export interface ToolPermissionDecision {
  approved: boolean;
  decidedBy: string;
  decidedAt: ISODateString;
  reason?: string;
}

export type ToolAuthorizationDecision =
  | {
      status: "allowed";
      reason?: string;
    }
  | {
      status: "denied";
      reason: string;
    }
  | {
      status: "requires_approval";
      reason: string;
      preview?: JsonObject;
    };

export interface ApprovedToolExecutionRequest extends ToolExecutionRequest {
  authorization: Extract<ToolAuthorizationDecision, { status: "allowed" }>;
}

export interface ScopedSecretResolver {
  getSecret(name: string): Promise<string | undefined>;
}

export interface ToolExecutionContext extends RuntimeCallContext {
  permissionDecision?: ToolPermissionDecision;
  secrets?: ScopedSecretResolver;
}

export type ToolRuntimeContext = ToolExecutionContext;

export type ToolExecutionErrorCode =
  | "tool_not_found"
  | "not_allowed"
  | "approval_required"
  | "validation_failed"
  | "handler_failed"
  | "cancelled"
  | "timed_out"
  | "repeated_tool_call";

export interface ToolExecutionError {
  code: ToolExecutionErrorCode;
  message: string;
  details?: JsonValue;
}

export interface ToolHandlerSuccessResult<TOutput = unknown> {
  status: "success";
  output?: TOutput;
  privateOutput?: unknown;
  display?: ToolDisplayOutput;
  artifacts?: ManagedArtifactRef[];
  auditSummary?: AuditSafeSummary;
}

export interface ToolHandlerFailureResult {
  status: "failed" | "cancelled" | "timed_out";
  error: ToolExecutionError;
  auditSummary?: AuditSafeSummary;
}

export type ToolHandlerResult<TOutput = unknown> =
  | ToolHandlerSuccessResult<TOutput>
  | ToolHandlerFailureResult;

export type ToolExecutionResult = ToolHandlerResult<unknown>;

export interface ToolExecution {
  authorize(
    request: ToolExecutionRequest,
    context: ToolExecutionContext
  ): Promise<ToolAuthorizationDecision>;
  execute(
    request: ApprovedToolExecutionRequest,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult>;
}
