import type {
  TOOL_DECISION_MODES,
  TOOL_DECISION_OUTCOMES,
  ToolInputParseErrorCode
} from "@work-shape/catalyst-asset-schemas";
export type { ToolInputParseErrorCode } from "@work-shape/catalyst-asset-schemas";

import type { OperationRunId, ToolCallId } from "./ids";
import type { JsonValue } from "./json";
import type { StartedSubagent } from "./subagents";
import type { ISODateString } from "./time";

// A run that pauses on a call that waits for a person's decision, and how it resumes
// (events F8). The run keeps what it needs to go on in `agent_runs.resume_state`, written in
// the transaction that sets it waiting and cleared when it ends.

/** How a call waits: for its own person's confirmation, or for another person's approval. */
export type ToolDecisionMode = (typeof TOOL_DECISION_MODES)[number];

/** What became of a call that waited for a decision. */
export type ToolDecisionOutcome = (typeof TOOL_DECISION_OUTCOMES)[number];

/**
 * What the tool runner answers for a call that waits for a decision instead of a result: the
 * call is not executed, and its Operation Run waits. Only a call that an Agent Run's worker
 * makes can wait; every other surface is refused such a call.
 */
export interface ToolDecisionWait {
  status: "waiting_for_decision";
  operationRunId: OperationRunId;
  /** The registered operation the call is. */
  operationId: string;
  /** Human target title supplied by the operation, separate from the executable input. */
  targetTitle?: string;
  mode: ToolDecisionMode;
  /** The validated input as it is executed after the decision. A call whose input holds a secret never waits. */
  frozenInput: JsonValue;
  expiresAt: ISODateString;
}

/** The payload of `tool_decision_requested`, beside the event's run, sequence and time. */
export interface ToolDecisionRequested {
  toolCallId: ToolCallId;
  toolName: string;
  operationRunId: OperationRunId;
  operationId: string;
  /** Human target title supplied by the operation, separate from the executable input. */
  targetTitle?: string;
  mode: ToolDecisionMode;
  /** The frozen input as the person is shown it. */
  inputPreview: JsonValue;
  expiresAt: ISODateString;
}

/** The payload of `tool_decision_recorded`: every open view closes the call's prompt from it. */
export interface ToolDecisionRecorded {
  toolCallId: ToolCallId;
  operationRunId: OperationRunId;
  outcome: ToolDecisionOutcome;
  /** The id of the person who decided, where a person did. */
  decidedBy?: string;
  /** The reason a person gave for a decline. */
  reason?: string;
}

/** One tool call of the step a run paused in, as the model wrote it. */
export interface PausedToolCall {
  toolCallId: string;
  toolName: string;
  input: JsonValue;
  inputParseError?: { code: ToolInputParseErrorCode; message: string; rawInput?: string };
}

/** A call of the paused step that waits for a decision, with the input it is executed with. */
export interface WaitingToolCall {
  toolCallId: string;
  operationRunId: OperationRunId;
  frozenInput: JsonValue;
}

/**
 * What a run that waits for a decision keeps to go on where it stopped. Calls run in order: at
 * the first call that waits the run pauses, and the calls after it have not started.
 */
export interface AgentRunResumeState {
  version: 1;
  /** The step of the run that paused, counted from 0. */
  step: number;
  /** The stored assistant message of that step, which names its tool calls. */
  stepMessageId: string;
  /**
   * Where the model's input starts on resume: after the conversation's history and the input
   * message, or at the step message of the last step whose answer compacted the context.
   */
  modelInputFrom: { kind: "input" } | { kind: "message"; messageId: string };
  /** Every call of the paused step, in the order the model wrote them. */
  toolCalls: PausedToolCall[];
  /** The calls of the step that ended before the pause. */
  doneToolCallIds: string[];
  /** The calls the run waits on. It resumes once each of their Operation Runs is decided. */
  waiting: WaitingToolCall[];
  /** How often the run made each identical call so far, by the key the limit counts. */
  repeatedToolCalls: Record<string, number>;
  /** The provider continuation of the paused step's answer, sent unchanged on resume. */
  providerContinuation?: { providerId: string; state: JsonValue };
  /** Whether an answer of the run compacted the context. */
  compacted: boolean;
  /**
   * The subagents the paused step started, in call order (CR-1). A run that waits for its
   * subagents keeps them here and, once all ended, answers each `run_agent` call with its outcome.
   */
  subagents?: StartedSubagent[];
}

/** What a run that resumes starts from, beside its input. */
export interface AgentRunResume {
  state: AgentRunResumeState;
  /** The last event the run stored: its events go on after it. */
  lastSequence: number;
}
