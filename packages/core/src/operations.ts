import { IDEMPOTENCY_KEY_MAX_LENGTH, type OperationEffect } from "@vivd-catalyst/asset-schemas";
import type { OperationDenial } from "./operation-denial";
import type { ManagedArtifactRef, ToolDisplayOutput } from "./files";
import type { AuthenticatedIdentity, RuntimeCallContext } from "./identity";
import type {
  AgentRunId,
  CollaborationWorkspaceId,
  ConversationId,
  OperationRunId,
  ToolCallId
} from "./ids";
import type { StructuredResultPublication } from "./structured-result";
import type { ISODateString } from "./time";
import type { ToolExecutionRequest, ToolExecutionResult } from "./tool-execution";

export { IDEMPOTENCY_KEY_MAX_LENGTH, type OperationEffect };

/** From the loosest to the strictest. Where several values meet, the strictest wins. */
export const POLICY_VALUES = ["allow", "confirm", "approval", "deny"] as const;

export type PolicyValue = (typeof POLICY_VALUES)[number];

/** What a call of a frame reached: an operation of a Connection, or a Data Store. */
export type AppCallTarget = { connection: string; operation: string } | { dataStore: string };

export type OperationOrigin =
  | {
      kind: "agent";
      agentRunId: AgentRunId;
      conversationId: ConversationId;
      agentName: string;
      toolCallId: ToolCallId;
      toolName: string;
      /**
       * The revision of what a data tool was read from when the call was made, where its
       * source names one. A call that waited runs only while that revision still stands.
       */
      toolRevisionId?: string;
    }
  | { kind: "user" }
  | { kind: "cli" }
  | { kind: "mcp"; clientName?: string }
  | {
      kind: "app";
      /**
       * The App the frame shows, by its name. A Page of a conversation names none. A call
       * that is executed later is asked by it whether its App still stands and its caller may
       * still use it.
       */
      appName?: string;
      appRevisionId: string;
      actionName: string;
      pageSessionId: string;
      conversationId?: ConversationId;
      /**
       * What the call reached, by name: the Connection and the operation of it, or the Data
       * Store a statement read. Kept so that a run of a named action says what it touched.
       * Never an input or a result.
       */
      target?: AppCallTarget;
    }
  /**
   * A step of a Workflow Run. The `actor` of the call is the principal the run acts as
   * (`WorkflowRunPrincipal`), whatever started the run.
   */
  | { kind: "workflow"; workflowRunId: string; stepRunId: string }
  /**
   * A due time, with nobody present. A `schedule` trigger starts its Workflow Run from this
   * origin as the run's principal; the steps of that run then call from the origin `workflow`.
   */
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

/**
 * What only the live call has and no frozen call keeps: how long it may take, who may stop
 * it, the language of its caller and, for a call an Agent Run makes, the hold of that run. A
 * call that is executed later, after an approval, runs without it.
 */
export type OperationCallRuntime = Pick<
  RuntimeCallContext,
  "locale" | "deadline" | "signal" | "runFence"
> & {
  /**
   * Set where the surface could not read the caller's input at all. The call then ends as an
   * invalid input with this text, after the surface's own check and before anything runs.
   */
  unreadableInput?: { code: string; message: string };
};

/**
 * Runs the call of an agent tool as an operation and answers as the agent reads it. The agent
 * runtime knows its tools through this alone.
 */
export type ToolOperationRunner = (
  request: ToolExecutionRequest,
  context: RuntimeCallContext,
  options?: Pick<OperationCallRuntime, "unreadableInput">
) => Promise<ToolExecutionResult>;

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
  /** See `toolRevisionId` of the agent origin. */
  toolRevisionId?: string;
}): OperationCall {
  const { request, toolRevisionId, ...context } = input;
  return {
    ...context,
    input: request.input,
    origin: {
      kind: "agent",
      agentRunId: request.agentRunId,
      conversationId: request.conversationId,
      agentName: request.agentName,
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      ...(toolRevisionId === undefined ? {} : { toolRevisionId })
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
