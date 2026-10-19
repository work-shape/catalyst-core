import { TOOL_GROUPS } from "@work-shape/catalyst-asset-schemas";
import type { AuditSafeSummary, ManagedArtifactRef, ToolDisplayOutput } from "./files";
import type { OperationBeforeEvent } from "./guardrail-events";
import type { RuntimeCallContext } from "./identity";
import type {
  AgentRunId,
  CollaborationWorkspaceId,
  ConversationId,
  OperationRunId,
  ToolCallId
} from "./ids";
import type { JsonObject, JsonValue } from "./json";
import type { StructuredResultPublication } from "./structured-result";

export type ToolPermissionMode = "allow" | "deny" | "approval_required";

export interface ToolPermissionPolicy {
  mode: ToolPermissionMode;
  reason?: string;
  requiredPermissionRefs?: string[];
}

/** A text people read, in both languages of the interface. */
export interface ToolText {
  en: string;
  de: string;
}

/**
 * Where the agent page shows a tool among the instance's tools. `instance` is the instance's own
 * tools, which its deployment registers; it is also where a tool without a group stands.
 */
export { TOOL_GROUPS } from "@work-shape/catalyst-asset-schemas";

export type ToolGroup = (typeof TOOL_GROUPS)[number];

/**
 * What a tool tells people, beside the description the model reads. Every field is optional:
 * the interface shows the tool's name where the title is missing, the group `instance` where
 * the group is, and the generic tool icon for a missing or unknown icon.
 */
export interface ToolPresentation {
  /** A verb and an object, such as "Read document text". */
  title?: ToolText;
  /** One sentence on what the tool does for the people who use the agent. */
  summary?: ToolText;
  group?: ToolGroup;
  /** A key of the icon registry of `@work-shape/catalyst-ui`. */
  icon?: string;
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

/**
 * The narrow parameter a database executor takes for the one credential of its source. No
 * tool receives it: a Connection's credential comes from the `ConnectionCredentialResolver`.
 */
export interface ScopedSecretResolver {
  getSecret(name: string): Promise<string | undefined>;
}

export interface ToolExecutionContext extends RuntimeCallContext {
  toolRequest?: ToolExecutionRequest;
  /**
   * The Operation Run this call is, and the workspace it is in. A tool that calls a model
   * passes both on, so the usage of that call is a row of the run and the workspace.
   */
  operationRun?: { id: OperationRunId; workspaceId?: CollaborationWorkspaceId };
  /** See `beforeEvents` of an operation's execution context: the tool's own, as last asked. */
  beforeEvents?: readonly OperationBeforeEvent[];
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
  | "repeated_tool_call"
  /** A subagent's call needs a person's decision, which a subagent never waits for (CR-1). */
  | "confirmation_required"
  /** `run_agent` names an agent the run may not start as a subagent. */
  | "agent_not_available"
  /** `run_agent` beyond the subagents one step or one run may start. */
  | "subagent_limit";

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
  /** Host-only recovery; omitted from the error text sent to the model. */
  recovery?: "private_conversation";
  status: "failed" | "cancelled" | "timed_out";
  error: ToolExecutionError;
  auditSummary?: AuditSafeSummary;
}

export type ToolHandlerResult<TOutput = unknown> =
  ToolHandlerSuccessResult<TOutput> | ToolHandlerFailureResult;

export type ToolExecutionResult = ToolHandlerResult<unknown>;
