import type { AgentRun, AgentRunJobLease } from "./agent-runtime";
import type { AgentRunResumeState } from "./agent-run-resume";
import type {
  AgentRunId,
  ClientInstanceId,
  ConversationId,
  OperationRunId,
  ToolCallId
} from "./ids";
import type { ISODateString } from "./time";
import type { RunAgentResult } from "./subagents";
import type { ReasoningEffortConfig } from "./config";

// The store of Child Agent Runs (CR-1): a subagent's start, the parent's wait for its
// subagents, and what a parent and a person read of them. Apart from `subagents.ts`, which the
// run's own types use: these name Agent Runs and leases.

/** A subagent to start for a parent run's `run_agent` call. */
export interface StartSubagentRunInput {
  clientInstanceId: ClientInstanceId;
  parentRunId: AgentRunId;
  /** The Operation Run of the call: a retried call under its key finds the child it started. */
  parentOperationRunId: OperationRunId;
  agentName: string;
  modelBindingId?: string;
  reasoningEffort?: ReasoningEffortConfig;
  /** The thread's title. */
  description: string;
  /** The child's whole input, its thread's first message. */
  task: string;
  correlationId: string;
}

export type StartSubagentRunResult =
  | { status: "started"; run: AgentRun; threadId: ConversationId }
  /** The parent started as many subagents as one run may. Nothing was started. */
  | { status: "limit_reached" };

/** A subagent as the Resources panel and the thread view read it. */
export interface SubagentSummary {
  runId: AgentRunId;
  threadId: ConversationId;
  parentRunId: AgentRunId;
  /** The parent's `run_agent` call that started it. */
  toolCallId: ToolCallId;
  agentName: string;
  description: string;
  status: AgentRun["status"];
  startedAt: ISODateString;
  endedAt?: ISODateString;
}

/** How a subagent ended, as its parent reads it; `open` while it has not. */
export type SubagentOutcome =
  { runId: AgentRunId; status: "open" } | ({ runId: AgentRunId } & RunAgentResult);

export interface WorkflowAgentRunData {
  runId: AgentRunId;
  status: AgentRun["status"];
  usage: { modelCallCount: number; inputTokens: number; outputTokens: number; totalTokens: number };
  transcript?: {
    role: string;
    text: string;
    toolCalls?: { toolName: string; input?: unknown }[];
  }[];
}

export interface ChildAgentRunStore {
  readWorkflowAgentData(input: {
    clientInstanceId: ClientInstanceId;
    stepRunId: string;
    includeTranscript: boolean;
  }): Promise<WorkflowAgentRunData | undefined>;

  /** Called under the Workflow run lock; the unique step key makes retries idempotent. */
  startWorkflowAgentRun(input: {
    clientInstanceId: ClientInstanceId;
    runId: string;
    stepRunId: string;
    principal: import("./identity").WorkflowRunPrincipal;
    tester?: import("./identity").AuthenticatedUser;
    task: string;
    title: string;
    correlationId: string;
    retainedUntil: ISODateString;
  }): Promise<AgentRun>;
  cancelWorkflowAgentRuns(input: {
    clientInstanceId: ClientInstanceId;
    runId: string;
  }): Promise<void>;
  readWorkflowAgentRun(input: {
    clientInstanceId: ClientInstanceId;
    stepRunId: string;
  }): Promise<AgentRun | undefined>;

  /**
   * Starts a subagent of a running parent in one transaction: its run thread, its task as
   * the thread's first message, its run and its job. The call under the same Operation Run
   * answers the child it started. The parent's root conversation, then the parent run, are
   * locked first.
   */
  startSubagentRun(input: StartSubagentRunInput): Promise<StartSubagentRunResult>;
  /**
   * Ends this execution of a run whose step started subagents that have not all ended: the
   * run waits as `waiting_for_subagents` with no lease and no job, keeping `resumeState`. A
   * run whose subagents all ended meanwhile is queued again with its job instead. Refused
   * once the run was asked to cancel.
   */
  pauseClaimedAgentRunForSubagents(input: {
    clientInstanceId: ClientInstanceId;
    runId: AgentRunId;
    lease: AgentRunJobLease;
    resumeState: AgentRunResumeState;
  }): Promise<{ status: Extract<AgentRun["status"], "waiting_for_subagents" | "queued"> }>;
  /** How each of a parent's subagents ended, in the order asked. */
  readSubagentOutcomes(input: {
    clientInstanceId: ClientInstanceId;
    parentRunId: AgentRunId;
    runIds: readonly AgentRunId[];
  }): Promise<SubagentOutcome[]>;
  /** The run threads of a chat Conversation, whatever their status, for its cleanup. */
  listRunThreadIds(input: {
    clientInstanceId: ClientInstanceId;
    rootConversationId: ConversationId;
  }): Promise<ConversationId[]>;
  /** The subagents of a chat conversation's runs, newest first. */
  listSubagents(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }): Promise<SubagentSummary[]>;
}
