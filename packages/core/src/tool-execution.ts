import type {
  AgentRunId,
  CollaborationWorkspaceId,
  ConversationId,
  OperationRunId,
  ToolCallId
} from "./ids";
import type { JsonObject, JsonValue } from "./json";
import type { AuditSafeSummary, ManagedArtifactRef, ToolDisplayOutput } from "./files";
import type { StructuredResultPublication } from "./structured-result";
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

export interface ScopedSecretResolver {
  getSecret(name: string): Promise<string | undefined>;
}

export interface ToolExecutionContext extends RuntimeCallContext {
  secrets?: ScopedSecretResolver;
  toolRequest?: ToolExecutionRequest;
  /**
   * The Operation Run this call is, and the workspace it is in. A tool that calls a model
   * passes both on, so the usage of that call is a row of the run and the workspace.
   */
  operationRun?: { id: OperationRunId; workspaceId?: CollaborationWorkspaceId };
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
  structuredResult?: StructuredResultPublication;
  artifacts?: ManagedArtifactRef[];
  auditSummary?: AuditSafeSummary;
}

export interface ToolHandlerFailureResult {
  status: "failed" | "cancelled" | "timed_out";
  error: ToolExecutionError;
  auditSummary?: AuditSafeSummary;
}

export type ToolHandlerResult<TOutput = unknown> =
  ToolHandlerSuccessResult<TOutput> | ToolHandlerFailureResult;

export type ToolExecutionResult = ToolHandlerResult<unknown>;
