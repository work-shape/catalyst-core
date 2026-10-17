import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  POLICY_VALUES,
  type OperationEffect
} from "@work-shape/catalyst-asset-schemas";
import type { ManagedArtifactRef, ToolDisplayOutput } from "./files";
import type { ActingServicePrincipal, AuthenticatedIdentity, RuntimeCallContext } from "./identity";
import type {
  AgentRunId,
  CollaborationWorkspaceId,
  ConversationId,
  OperationRunId,
  ToolCallId
} from "./ids";
import type { OperationDenial } from "./operation-denial";
import type { StructuredResultPublication } from "./structured-result";
import type { ISODateString } from "./time";
import type { ToolExecutionRequest, ToolExecutionResult } from "./tool-execution";
import type { ToolDecisionWait } from "./agent-run-resume";

export { IDEMPOTENCY_KEY_MAX_LENGTH, type OperationEffect };

/** From the loosest to the strictest. Where several values meet, the strictest wins. */
export { POLICY_VALUES } from "@work-shape/catalyst-asset-schemas";

export type PolicyValue = (typeof POLICY_VALUES)[number];

/** What a call of a frame reached: an operation of a Connection, a Data Store, or a Workflow it started. */
export type AppCallTarget =
  { connection: string; operation: string } | { dataStore: string } | { workflow: string };

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
  /**
   * An API credential. `unattended`: the call was sent with `Catalyst-Unattended: 1`, so
   * nobody answers for it at the terminal and it is not its caller's own confirmation: a
   * `confirm` waits in the person's Inbox (OP-4b). The header only makes a call stricter.
   */
  | { kind: "cli"; unattended?: true }
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
       * What the call reached, by name: the Connection and the operation of it, the Data
       * Store a statement read, or the Workflow it started. Kept so that a run of a named action says what it touched.
       * Never an input or a result.
       */
      target?: AppCallTarget;
    }
  /**
   * A step of a Workflow Run. The `actor` of the call is the principal the run acts as
   * (`WorkflowRunPrincipal`), whatever started the run. In a test run of a draft the actor is
   * the person testing, and `boundBy` names the principal whose rights bound theirs; the call
   * path writes it from the call's draft context, so it says what was asked.
   */
  | {
      kind: "workflow";
      workflowRunId: string;
      stepRunId: string;
      boundBy?: { id: string; label: string };
    }
  /**
   * A due time, with nobody present. A `schedule` trigger starts its Workflow Run from this
   * origin as the run's principal; the steps of that run then call from the origin `workflow`.
   */
  | { kind: "schedule"; scheduleId: string };

/**
 * What a call made by a draft carries (ADR-0031): the draft asset, the revision of it that
 * made the call and the App action or Workflow step that made it. `runOperation()` decides from
 * it where the call goes: a reading call reads live, a changing call is simulated unless "Run
 * live once" was switched on for this action or step of this revision.
 */
export interface OperationDraftContext {
  /** The App or the Workflow whose draft makes the call. */
  asset: { kind: string; id: string; name: string };
  /** The draft revision that made the call. A switch set for another revision does not apply. */
  revisionId: string;
  /** The App action or the Workflow step, by its name. */
  part: string;
  /**
   * A test run of a Workflow draft: the service principal the Workflow runs as. The call is
   * made as the person testing and allowed only where the principal holds the right too.
   */
  boundBy?: ActingServicePrincipal;
  /**
   * A test run whose start was the tester's own confirmation: they called `workflows.test`
   * themselves, or confirmed an agent's call of it. A step's `confirm` is then satisfied by
   * that start, as a person's direct call satisfies it; `approval` still gates the step.
   */
  startConfirmed?: boolean;
}

export interface OperationCall<TInput = unknown> {
  operation: string;
  effect: OperationEffect;
  input: TInput;
  actor: AuthenticatedIdentity;
  origin: OperationOrigin;
  workspaceId?: CollaborationWorkspaceId;
  idempotencyKey?: string;
  correlationId: string;
  /** Set where a draft makes the call. A call without it is a call of what is live. */
  draft?: OperationDraftContext;
  /**
   * Set on a step of a run of a published revision whose Workflow was deleted since the run
   * started: the publish approves none of the run's calls any more.
   */
  workflowDeleted?: true;
}

/**
 * What only the live call has and no frozen call keeps: how long it may take, who may stop
 * it, the language of its caller and, for a call an Agent Run makes, the hold of that run. A
 * call that is executed later, after an approval, runs without it.
 */
export type OperationCallRuntime = Pick<
  RuntimeCallContext,
  "locale" | "deadline" | "signal" | "runFence" | "subagent" | "unattended"
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
) => Promise<ToolExecutionResult | ToolDecisionWait>;

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
      /** The Inbox item the confirmation waits in, where it waits in its person's Inbox (OP-4b). */
      approvalRequestId?: string;
    }
  | {
      status: "pending_approval";
      runId: OperationRunId;
      approvalRequestId: string;
      expiresAt: ISODateString;
    }
  | { status: "denied"; runId: OperationRunId; reason: OperationDenial }
  | {
      /**
       * A changing call of a draft that was not made. `input` is the validated input it would
       * have been made with, absent where it holds a secret. `wouldAsk` says whether the live
       * call would have waited for its caller's confirmation or another person's approval.
       */
      status: "dry_run";
      runId: OperationRunId;
      input?: unknown;
      wouldAsk?: "confirmation" | "approval";
    }
  | {
      status: "failed";
      runId: OperationRunId;
      error: { code: string; message: string; details?: Record<string, unknown> };
    }
  | { status: "expired"; runId: OperationRunId }
  /**
   * The call of an operation with `completion: async` started its work, which goes on after
   * the call. The run ends later. A call made again under the same key answers the same run.
   */
  | { status: "running"; runId: OperationRunId };

/**
 * Whether the caller of this origin is present and the call is its own, so that the call
 * itself is the confirmation a `confirm` policy asks for. An agent, a workflow and a schedule
 * act for somebody who is not the caller, and a CLI call marked unattended has nobody at its
 * terminal to answer for it.
 */
export function callerCanConfirm(origin: OperationOrigin): boolean {
  return originConfirms(origin);
}

/**
 * Whether the call is its caller's own confirmation: a call from an origin whose caller is
 * present, or a step of a Workflow test run whose tester's own start was the confirmation
 * (ADR-0031). A step of any other run has nobody to ask.
 */
export function callConfirmedByCaller(call: Pick<OperationCall, "origin" | "draft">): boolean {
  return (
    originConfirms(call.origin) ||
    (call.draft?.boundBy !== undefined && call.draft.startConfirmed === true)
  );
}

function originConfirms(origin: OperationOrigin): boolean {
  switch (origin.kind) {
    case "cli":
      return origin.unattended !== true;
    case "user":
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
