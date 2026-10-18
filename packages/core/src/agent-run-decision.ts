import type { AppAudience } from "./app-audience";
import type { AgentRun } from "./agent-runtime";
import type { RuntimeCallContext } from "./identity";
import type { ClientInstanceId, OperationRunId } from "./ids";
import type { JsonValue } from "./json";
import type { OperationDenial } from "./operation-denial";
import type { OperationRun, OperationRunDecision, OperationRunError } from "./operation-runs";
import type { ToolExecutionRequest, ToolExecutionResult } from "./tool-execution";

// A person's decision on a call an Agent Run waits on, and how the decided call is carried
// out (EW-2a). Apart from `agent-run-resume.ts`, which the run's own types use: these name
// Operation Runs and tool results.

/**
 * Carries out a call that waited for a decision and was decided: the confirmed call is
 * executed once, keyed by its Operation Run; a declined or expired one answers what the agent
 * reads instead of a result.
 */
export type ToolDecisionRunner = (
  call: {
    request: ToolExecutionRequest;
    operationRunId: OperationRunId;
    frozenInput: JsonValue;
  },
  context: RuntimeCallContext
) => Promise<ToolExecutionResult>;

/**
 * `details.reason` of the CONFLICT a decision answers when the call's time ran out before it
 * was decided: nothing ran. Every other CONFLICT of a decision means the call was decided
 * otherwise first, and may have run.
 */
export const DECISION_EXPIRED_REASON = "decision_expired";

/** A person's decision on a call an Agent Run waits on. */
export interface DecideWaitingToolCallInput {
  clientInstanceId: ClientInstanceId;
  /** The id a caller named: an id no run has is NOT_FOUND. */
  operationRunId: string;
  /** Only the person the run works for decides. */
  deciderUserId: string;
  /** Only a person confirming an App publish may replace its proposed audience. */
  audience?: AppAudience;
  decision: OperationRunDecision & { mode: "confirmed" | "declined" };
  /** How a declined call's run ends. */
  declined?: { error: OperationRunError; denial: OperationDenial };
}

export interface DecidedWaitingToolCall {
  operationRun: OperationRun;
  agentRun: AgentRun;
  /** The same decision was recorded before: nothing changed. */
  repeated: boolean;
}

export interface AgentRunDecisionStore {
  /**
   * Records a person's decision on a call a run waits on, in one transaction: the call's
   * Operation Run keeps the decision, a `tool_decision_recorded` event is appended, and once
   * every call the run waits on is decided the run is queued again with a job that resumes it.
   * The same decision again answers the same runs; a different one is a CONFLICT.
   */
  decideWaitingToolCall(input: DecideWaitingToolCallInput): Promise<DecidedWaitingToolCall>;
}
