import {
  AGENT_RUN_FAILURE_CATEGORIES,
  AGENT_RUN_STATUSES,
  LIVE_JOB_STATUSES,
  TOOL_CALL_STATES
} from "@work-shape/catalyst-asset-schemas";
import type { ModelUsageRefusal } from "./errors";
import type { ConversationFollowUp } from "./follow-ups";
import type { ReasoningEffortConfig } from "./config";
import type { AppendAssistantMessageInput, ChatMessage, CreateMessageInput } from "./conversation";
import type { AttachmentManifest, ManagedFileRef, SubjectRowClaim } from "./files";
import type { AuthPrincipal, AuthScope, DelegatedActor, RuntimeCallContext } from "./identity";
import type {
  AgentRunId,
  ClientInstanceId,
  CollaborationWorkspaceId,
  ConversationId,
  MessageId,
  ToolCallId
} from "./ids";
import type { JobId } from "./jobs";
import type { JsonObject } from "./json";
import type { LocaleCode } from "./localization";
import type { ISODateString } from "./time";
import type { ToolExecutionResult } from "./tool-execution";
import type {
  AgentRunResume,
  AgentRunResumeState,
  ToolDecisionRecorded,
  ToolDecisionRequested
} from "./agent-run-resume";
import type { SubagentRef, SubagentStarted } from "./subagents";

export interface StartAgentRunInput {
  agentName: string;
  modelBindingId?: string;
  /** The reasoning effort the user picked; unset runs with the configured default. */
  reasoningEffort?: ReasoningEffortConfig;
  conversationId: ConversationId;
  idempotencyKey?: string;
  inputMessageId?: MessageId;
  preparedRun?: {
    id: AgentRunId;
    startedAt: ISODateString;
  };
  message: {
    text: string;
    files?: ManagedFileRef[];
    attachmentManifest?: AttachmentManifest;
  };
  /** Set where the run waited for a decision and goes on where it stopped. */
  resume?: AgentRunResume;
}

export interface AgentRunHandle {
  runId: AgentRunId;
  status: AgentRunStatus;
  startedAt: ISODateString;
}

export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

export type AgentRunFailureCategory = (typeof AGENT_RUN_FAILURE_CATEGORIES)[number];

export interface AgentRunError {
  code: string;
  message: string;
  category: AgentRunFailureCategory;
  /**
   * The tool the run waited on when it was ended for standing still. Its name, never its input
   * or output.
   */
  tool?: string;
  /** The usage limit that refused the run's model call: which one it was, never its counts. */
  usageLimit?: ModelUsageRefusal;
}

export interface AgentRunAuthorization {
  principal: AuthPrincipal;
  subjectUserId: string;
  delegatedActor?: DelegatedActor;
  scopes: AuthScope[];
}

export interface AgentRun {
  id: AgentRunId;
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  ownerUserId: string;
  /** Of a subagent: the run whose `run_agent` call started it. It is never started deeper. */
  parentRunId?: AgentRunId;
  inputMessageId: MessageId;
  agentName: string;
  modelBindingId?: string;
  /** The reasoning effort the user picked; unset runs with the configured default. */
  reasoningEffort?: ReasoningEffortConfig;
  locale?: LocaleCode;
  authorization?: AgentRunAuthorization;
  status: AgentRunStatus;
  idempotencyKey?: string;
  startedAt: ISODateString;
  updatedAt: ISODateString;
  completedAt?: ISODateString;
  cancelledAt?: ISODateString;
  failedAt?: ISODateString;
  lastSequence: number;
  error?: AgentRunError;
  correlationId: string;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: ISODateString;
  heartbeatAt?: ISODateString;
  cancellationRequestedAt?: ISODateString;
  cancellationReason?: string;
}

export interface ActiveRunSummary {
  id: AgentRunId;
  conversationId: ConversationId;
  agentName: string;
  status: AgentRunStatus;
  startedAt: ISODateString;
  updatedAt: ISODateString;
  lastSequence: number;
}

export type AgentRunProjectionPart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "reasoning";
      id: string;
      text: string;
      open: boolean;
    }
  | {
      type: "tool_call";
      toolCallId: ToolCallId;
      toolName: string;
      input?: unknown;
      state: (typeof TOOL_CALL_STATES)[number];
      output?: unknown;
      errorText?: string;
      /** The fixed recovery the host offers for an asset in a shared transcript. */
      errorReason?: "subject_conversation_shared";
      /** While the state is `waiting_for_decision`: what the person is asked to decide. */
      decision?: Omit<ToolDecisionRequested, "toolCallId" | "toolName">;
      /** On a `run_agent` call that started its subagent: the subagent, for its card. */
      subagent?: SubagentRef;
    };

export interface AgentRunProjection {
  runId: AgentRunId;
  lastSequence: number;
  status: AgentRunStatus;
  durationMs?: number;
  parts: AgentRunProjectionPart[];
  text: string;
  reasoning: Array<{
    id: string;
    text: string;
    open: boolean;
  }>;
  preparingTool?: {
    toolCallId: ToolCallId;
    toolName: string;
  };
  activeToolCalls: Array<{
    toolCallId: ToolCallId;
    toolName: string;
    input?: unknown;
    state: (typeof TOOL_CALL_STATES)[number];
    output?: unknown;
    errorText?: string;
    /** The fixed recovery the host offers for an asset in a shared transcript. */
    errorReason?: "subject_conversation_shared";
    decision?: Omit<ToolDecisionRequested, "toolCallId" | "toolName">;
    subagent?: SubagentRef;
  }>;
  error?: AgentRunError;
}

export interface RunObservation {
  clientInstanceId: ClientInstanceId;
  runId: AgentRunId;
  conversationId: ConversationId;
  ownerUserId: string;
  sequence: number;
  type: AgentRuntimeEvent["type"];
  payload: AgentRuntimeEvent;
  createdAt: ISODateString;
}

export type RunStartCommandKind = "start_conversation_run" | "create_conversation_run";

export interface RunStartCommand {
  clientInstanceId: ClientInstanceId;
  ownerUserId: string;
  idempotencyKey: string;
  commandKind: RunStartCommandKind;
  status: "pending" | "completed" | "failed";
  conversationId?: ConversationId;
  userMessageId?: MessageId;
  runId?: AgentRunId;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export type ClaimRunStartCommandResult =
  | {
      status: "claimed";
      command: RunStartCommand;
    }
  | {
      status: "existing";
      command: RunStartCommand;
    };

export interface AgentRuntimeObserveOptions {
  afterSequence?: number;
}

export type AgentRuntimeCommand = {
  type: "continue";
};

export type AgentRuntimeEvent =
  | {
      type: "follow_up_changed";
      runId: AgentRunId;
      sequence: number;
      createdAt: ISODateString;
      followUp: ConversationFollowUp;
    }
  | {
      type: "message_delta";
      runId: AgentRunId;
      sequence: number;
      createdAt: ISODateString;
      delta: string;
    }
  | {
      type: "reasoning_delta";
      runId: AgentRunId;
      sequence: number;
      createdAt: ISODateString;
      id: string;
      delta: string;
    }
  | {
      type: "message_completed";
      runId: AgentRunId;
      sequence: number;
      createdAt: ISODateString;
      message: {
        id: MessageId;
        role: "assistant";
        text: string;
        metadata?: JsonObject;
      };
    }
  | {
      type: "tool_call_preparing";
      runId: AgentRunId;
      sequence: number;
      createdAt: ISODateString;
      toolCallId: ToolCallId;
      toolName: string;
    }
  | {
      type: "tool_call_preparation_cancelled";
      runId: AgentRunId;
      sequence: number;
      createdAt: ISODateString;
      toolCallId: ToolCallId;
    }
  | {
      type: "tool_call_started";
      runId: AgentRunId;
      sequence: number;
      createdAt: ISODateString;
      toolCallId: ToolCallId;
      toolName: string;
      input: unknown;
    }
  | ({
      type: "tool_decision_requested";
      runId: AgentRunId;
      sequence: number;
      createdAt: ISODateString;
    } & ToolDecisionRequested)
  | ({
      type: "tool_decision_recorded";
      runId: AgentRunId;
      sequence: number;
      createdAt: ISODateString;
    } & ToolDecisionRecorded)
  | ({
      type: "subagent_started";
      runId: AgentRunId;
      sequence: number;
      createdAt: ISODateString;
    } & SubagentStarted)
  | {
      type: "tool_call_completed";
      runId: AgentRunId;
      sequence: number;
      createdAt: ISODateString;
      toolCallId: ToolCallId;
      toolName: string;
      result: ToolExecutionResult;
      modelOutput: string;
      projectionNotice?: JsonObject;
    }
  | {
      type: "tool_call_failed";
      runId: AgentRunId;
      sequence: number;
      createdAt: ISODateString;
      toolCallId: ToolCallId;
      toolName: string;
      result: ToolExecutionResult;
      modelOutput: string;
      projectionNotice?: JsonObject;
    }
  | {
      type: "run_completed";
      runId: AgentRunId;
      sequence: number;
      createdAt: ISODateString;
    }
  | {
      type: "run_cancelled";
      runId: AgentRunId;
      sequence: number;
      createdAt: ISODateString;
      reason?: string;
    }
  | {
      type: "run_failed";
      runId: AgentRunId;
      sequence: number;
      createdAt: ISODateString;
      error: {
        code: string;
        message: string;
        category: AgentRunFailureCategory;
      };
    };

export interface AgentRuntime {
  start(input: StartAgentRunInput, context: RuntimeCallContext): Promise<AgentRunHandle>;
  observe(
    runId: AgentRunId,
    context: RuntimeCallContext,
    options?: AgentRuntimeObserveOptions
  ): AsyncIterable<AgentRuntimeEvent>;
  getStatus(runId: AgentRunId, context: RuntimeCallContext): Promise<AgentRunStatus>;
  resume(
    runId: AgentRunId,
    command: AgentRuntimeCommand,
    context: RuntimeCallContext
  ): Promise<void>;
  cancel(runId: AgentRunId, reason: string | undefined, context: RuntimeCallContext): Promise<void>;
}

export interface CreateAgentRunInput {
  id: AgentRunId;
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  ownerUserId: string;
  inputMessageId: MessageId;
  agentName: string;
  modelBindingId?: string;
  /** The reasoning effort the user picked; unset runs with the configured default. */
  reasoningEffort?: ReasoningEffortConfig;
  locale?: LocaleCode;
  authorization?: AgentRunAuthorization;
  status?: (typeof LIVE_JOB_STATUSES)[number];
  idempotencyKey?: string;
  correlationId: string;
  startedAt?: ISODateString;
}

export interface PrepareConversationRunStartInput {
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  ownerUserId: string;
  userMessage: {
    id: MessageId;
    text: string;
    metadata?: JsonObject;
  };
  run: CreateAgentRunInput;
  runStartCommand?: {
    idempotencyKey: string;
    commandKind: RunStartCommandKind;
    claimedAt?: ISODateString;
  };
  followUp?: "queue";
  /** Effective defaults captured only for a queued message; immediate runs keep caller selections. */
  followUpSelection?: Pick<CreateAgentRunInput, "modelBindingId" | "reasoningEffort">;
  /** Internal dispatch: starts with this oldest pending item under the conversation lock. */
  dispatchFollowUpId?: string;
  /** One transcript row per queued item, in queue order; the last is the run input. */
  dispatchMessages?: Array<{
    followUpId: string;
    message: PrepareConversationRunStartInput["userMessage"];
  }>;
  dispatchAfterRunId?: AgentRunId;
  dispatchJobId?: JobId;
  claimReadyDraftAttachments?: boolean;
  /**
   * Moves the Conversation's retention date to this many days after the acceptance, measured on
   * the database clock, unless the date already lies later. Absent leaves the date alone.
   */
  extendRetentionDays?: number;
}

export type ConversationRunStartResult =
  PreparedConversationRunStart | { followUp: ConversationFollowUp };

export interface PreparedConversationRunStart {
  userMessage: ChatMessage;
  run: AgentRun;
  /** True when the conversation had no user message before this one. */
  firstUserMessage: boolean;
}

export interface UpdateAgentRunStatusInput {
  clientInstanceId: ClientInstanceId;
  runId: AgentRunId;
  status: AgentRunStatus;
  updatedAt: ISODateString;
  lastSequence?: number;
  completedAt?: ISODateString;
  cancelledAt?: ISODateString;
  failedAt?: ISODateString;
  error?: AgentRunError;
}

/**
 * The hold of one attempt of an `agent_run.execute` job on its run: the fence every write of
 * the run carries. A write is stored only while the job is running under this token.
 */
export interface AgentRunJobLease {
  jobId: JobId;
  leaseToken: string;
}

export interface ClaimAgentRunForJobInput {
  clientInstanceId: ClientInstanceId;
  runId: AgentRunId;
  lease: AgentRunJobLease;
  /** The lease copied onto the row lasts this long from now. */
  leaseMs: number;
}

/**
 * `claimed`: the run was queued and is this attempt's now. `finished`: the run has ended.
 * `held`: a worker of the previous release holds the run under a live lease. `started`: the
 * run was started before and nothing holds it; it must not be executed again.
 */
/**
 * A claimed run carries, beside its row, where it goes on when it waited for a decision. The
 * resume state is read by its worker alone and never leaves the store with the run.
 */
export type AgentRunJobClaim =
  | { status: "claimed"; row: AgentRun; resumeState?: AgentRunResumeState }
  | Exclude<SubjectRowClaim<AgentRun>, { status: "claimed" }>
  | { status: "started" };

export interface RenewAgentRunJobLeaseInput {
  clientInstanceId: ClientInstanceId;
  runId: AgentRunId;
  lease: AgentRunJobLease;
  leaseMs: number;
}

export interface RequestAgentRunCancellationInput {
  clientInstanceId: ClientInstanceId;
  runId: AgentRunId;
  requestedAt: ISODateString;
  reason?: string;
}

export interface AppendClaimedRunObservationInput {
  clientInstanceId: ClientInstanceId;
  runId: AgentRunId;
  lease: AgentRunJobLease;
  event: AgentRuntimeEvent;
}

export interface AssertClaimedAgentRunInput {
  clientInstanceId: ClientInstanceId;
  runId: AgentRunId;
  lease: AgentRunJobLease;
}

export interface AppendClaimedAgentRunMessageInput {
  clientInstanceId: ClientInstanceId;
  runId: AgentRunId;
  lease: AgentRunJobLease;
  message:
    ({ role: "assistant" } & AppendAssistantMessageInput) | ({ role: "tool" } & CreateMessageInput);
}

export interface AppendClaimedAgentRunEndInput {
  clientInstanceId: ClientInstanceId;
  runId: AgentRunId;
  lease: AgentRunJobLease;
  /** The last assistant message of the run, when it wrote one. */
  message?: { role: "assistant" } & AppendAssistantMessageInput;
  /** The events that follow, in order. The last one ends the run, or sets it waiting for a decision. */
  events: AgentRuntimeEvent[];
  /** Allocate durable sequence numbers under the row lock, alongside server observations. */
  allocateSequence?: boolean;
  /** What a run that ends waiting for a decision keeps to go on; required exactly then. */
  resumeState?: AgentRunResumeState;
}

export interface FailLostAgentRunInput {
  clientInstanceId: ClientInstanceId;
  runId: AgentRunId;
  /** The job whose worker is gone. A live lease of anyone else on the run is left alone. */
  jobId: JobId;
  error: AgentRunError;
}

/** A queued run without a job, as the adoption enqueues it. */
export interface AgentRunWithoutJob {
  id: AgentRunId;
  correlationId: string;
}

export interface ClaimRunStartCommandInput {
  clientInstanceId: ClientInstanceId;
  ownerUserId: string;
  idempotencyKey: string;
  commandKind: RunStartCommandKind;
  createdAt?: ISODateString;
  reclaimPendingBefore?: ISODateString;
}

export interface CompleteRunStartCommandInput {
  clientInstanceId: ClientInstanceId;
  ownerUserId: string;
  idempotencyKey: string;
  commandKind: RunStartCommandKind;
  claimedAt?: ISODateString;
  conversationId: ConversationId;
  userMessageId: MessageId;
  runId: AgentRunId;
  updatedAt: ISODateString;
}

export interface ReleaseRunStartCommandInput {
  clientInstanceId: ClientInstanceId;
  ownerUserId: string;
  idempotencyKey: string;
  commandKind: RunStartCommandKind;
  claimedAt?: ISODateString;
}

export interface AgentRunStore {
  claimRunStartCommand(input: ClaimRunStartCommandInput): Promise<ClaimRunStartCommandResult>;
  completeRunStartCommand(input: CompleteRunStartCommandInput): Promise<RunStartCommand>;
  releaseRunStartCommand(input: ReleaseRunStartCommandInput): Promise<void>;
  prepareConversationRunStart(
    input: PrepareConversationRunStartInput & { followUp?: undefined }
  ): Promise<PreparedConversationRunStart>;
  prepareConversationRunStart(
    input: PrepareConversationRunStartInput
  ): Promise<ConversationRunStartResult>;
  createAgentRun(input: CreateAgentRunInput): Promise<AgentRun>;
  getAgentRun(input: {
    clientInstanceId: ClientInstanceId;
    runId: AgentRunId;
  }): Promise<AgentRun | undefined>;
  getConversationAgentRun(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    runId: AgentRunId;
  }): Promise<AgentRun | undefined>;
  getActiveConversationAgentRun(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }): Promise<AgentRun | undefined>;
  getLatestConversationAgentRun(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }): Promise<AgentRun | undefined>;
  updateAgentRunStatus(input: UpdateAgentRunStatusInput): Promise<AgentRun>;
  /**
   * The first step of an `agent_run.execute` job: moves a queued run to running under the
   * job's lease. A run is executed only by the attempt this resolves `claimed` for.
   */
  claimAgentRunForJob(input: ClaimAgentRunForJobInput): Promise<AgentRunJobClaim>;
  /**
   * Extends the copy of the job's lease on the row, so a worker of the previous release sees
   * the run as held. False when the row no longer carries the token.
   */
  renewAgentRunJobLease(input: RenewAgentRunJobLeaseInput): Promise<boolean>;
  requestAgentRunCancellation(input: RequestAgentRunCancellationInput): Promise<AgentRun>;
  /**
   * The runs that have not ended, a cancelling one included: those a user started, those in
   * the Conversations of a workspace, or those of a chat Conversation and its run threads,
   * parents before their subagents.
   */
  listAgentRunsInProgress(
    input: { clientInstanceId: ClientInstanceId } & (
      | { ownerUserId: string }
      | { collaborationWorkspaceId: CollaborationWorkspaceId }
      | { rootConversationId: ConversationId }
    )
  ): Promise<AgentRun[]>;
  /**
   * Stores the next event of the run. Throws `JobLeaseLostError` when the job is no longer
   * running under the lease, and `CONFLICT` when the run has ended or the sequence is not the
   * next one. Nothing is stored in either case.
   */
  appendClaimedRunObservation(input: AppendClaimedRunObservationInput): Promise<RunObservation>;
  /** Throws `JobLeaseLostError` when the job is no longer running under the lease. */
  assertClaimedAgentRun(input: AssertClaimedAgentRunInput): Promise<AgentRun>;
  /**
   * Stores a message of the run under the job's lease and the Conversation row lock. Refused
   * with `JobLeaseLostError` after lease loss, and when the Conversation is no longer active
   * or the user who started the run or the workspace of the Conversation is being deleted:
   * nothing is written back after an erasure began.
   */
  appendClaimedAgentRunMessage(input: AppendClaimedAgentRunMessageInput): Promise<ChatMessage>;
  /**
   * Stores the end of a run in one transaction: its last assistant message, when one is
   * given, and its events in order. Refused as `appendClaimedAgentRunMessage` and
   * `appendClaimedRunObservation` refuse, and then nothing of it is stored.
   */
  appendClaimedAgentRunEnd(input: AppendClaimedAgentRunEndInput): Promise<void>;
  /**
   * Ends a run that was started and whose worker is gone: failed with `error` and a
   * `run_failed` event. A queued run was never started and is left for a new job; an ended
   * run is left alone, and so is a run that someone other than the job of `jobId` holds
   * under a live lease, a worker of the previous release for one. Resolves with the run when
   * it was failed here.
   */
  failLostAgentRun(input: FailLostAgentRunInput): Promise<AgentRun | undefined>;
  /**
   * Fails the runs that were accepted more than `queuedMs` ago and are still queued, oldest
   * first, each with `error` and a `run_failed` event. Resolves with the runs it failed.
   */
  failAgentRunsQueuedTooLong(input: {
    clientInstanceId: ClientInstanceId;
    queuedMs: number;
    error: AgentRunError;
    limit: number;
  }): Promise<AgentRun[]>;
  /**
   * Fails the runs that were started and that no worker holds any more, oldest first, each
   * with `error` and a `run_failed` event: the lease on the row ran out or was never set, and
   * no job of `jobKind` is running for the run. Resolves with the runs it failed.
   */
  failAgentRunsWithoutWorker(input: {
    clientInstanceId: ClientInstanceId;
    jobKind: string;
    error: AgentRunError;
    limit: number;
  }): Promise<AgentRun[]>;
  /**
   * The queued runs that have no queued or running job of `jobKind`, oldest first. The
   * upkeep enqueues a job for each.
   */
  listAgentRunsWithoutJob(input: {
    clientInstanceId: ClientInstanceId;
    jobKind: string;
    limit: number;
  }): Promise<AgentRunWithoutJob[]>;
}

export interface AppendRunObservationInput {
  clientInstanceId: ClientInstanceId;
  runId: AgentRunId;
  conversationId: ConversationId;
  ownerUserId: string;
  event: AgentRuntimeEvent;
}

export interface RunObservationStore {
  appendRunObservation(input: AppendRunObservationInput): Promise<RunObservation>;
  listRunObservations(input: {
    clientInstanceId: ClientInstanceId;
    runId: AgentRunId;
    afterSequence?: number;
    limit?: number;
  }): Promise<RunObservation[]>;
}
