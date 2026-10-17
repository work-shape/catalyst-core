import type { EndedAgentRunStatus } from "@work-shape/catalyst-asset-schemas";
import type { AgentRunId, ConversationId, OperationRunId, ToolCallId } from "./ids";

// Subagents (CR-1; events-workflows-and-guardrails.md, Child Agent Runs): an agent hands a
// sub-task to another agent with the tool `run_agent`. Each subagent is a Child Agent Run in a
// run thread of its own and acts as the parent run's person. The parent starts its subagents at
// once, goes on with the step and, at the end of the step, waits without a worker until every
// subagent it started has ended. It then reads each answer as the result of its call.

/** The agent's tool that starts a subagent. */
export const RUN_AGENT_TOOL_NAME = "run_agent";

/** The operation a `run_agent` call is. An administrator's policy names this. */
export const AGENTS_RUN_OPERATION = "agents.run";

/** How many subagents one step of a run starts at most (Q4). */
export const SUBAGENTS_PER_STEP = 4;

/** How many subagents one run starts at most (Q4). */
export const SUBAGENTS_PER_RUN = 16;

/** The most characters of a subagent's description: its card and its thread's title. */
export const SUBAGENT_DESCRIPTION_MAX_LENGTH = 80;

/** The most characters of a subagent's task, which is the whole of its input. */
export const SUBAGENT_TASK_MAX_LENGTH = 20_000;

/** The most characters of a subagent's answer its parent reads; the thread keeps all of it. */
export const SUBAGENT_ANSWER_MAX_LENGTH = 20_000;

/** The most files of a subagent its parent reads. */
export const SUBAGENT_FILES_MAX = 20;

/** The tool errors of `run_agent` a parent's model reads. */
export const RUN_AGENT_ERROR_CODES = ["agent_not_available", "subagent_limit"] as const;

/** A `run_agent` call of the step a run paused in, and the subagent it started. */
export interface StartedSubagent {
  toolCallId: string;
  operationRunId: OperationRunId;
  runId: AgentRunId;
}

/** What the parent's model reads as the result of a `run_agent` call once its subagent ended. */
export interface RunAgentResult {
  status: EndedAgentRunStatus;
  /** The subagent's Agent Run. */
  runId: string;
  agent: string;
  /** The subagent's final text, when it completed. */
  answer?: string;
  /** Set where the answer was cut: the whole answer stays in the run thread. */
  answerTruncated?: true;
  /** The files the subagent made, in the root conversation. */
  files?: { id: string; name: string; mimeType: string }[];
  /** Why it failed or was cancelled. Never a provider's text. */
  error?: { code: string; message: string };
}

/**
 * The payload of `subagent_started`, beside the event's run, sequence and time: the parent's
 * worker writes it when the call started its subagent, so a card finds its child after a reload.
 */
export interface SubagentStarted {
  toolCallId: ToolCallId;
  /** The subagent's run; the event's own `runId` is the parent's. */
  subagentRunId: AgentRunId;
  threadId: ConversationId;
  agent: string;
  description: string;
}

/** The subagent a `run_agent` call started, as the call's card reads it. */
export interface SubagentRef {
  runId: AgentRunId;
  threadId: ConversationId;
  agent: string;
  description: string;
}
