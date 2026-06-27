import type { AgentRunId, ClientInstanceId, ConversationId, MessageId, ToolCallId } from "./ids";
import type { JsonObject } from "./json";
import type { ISODateString } from "./time";
import type { ManagedFileRef } from "./files";
import type { AttachmentManifest } from "./files";
import type { RuntimeCallContext } from "./identity";
import type { ToolExecutionResult } from "./tool-execution";
import type { ChatMessage } from "./conversation";

export interface StartAgentRunInput {
  agentName: string;
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
}

export interface AgentRunHandle {
  runId: AgentRunId;
  status: AgentRunStatus;
  startedAt: ISODateString;
}

export type AgentRunStatus =
  | "queued"
  | "running"
  | "waiting_for_permission"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "failed";

export type AgentRunFailureCategory =
  | "app_error"
  | "internal_error"
  | "abort_error"
  | "unknown_error";

export interface AgentRunError {
  code: string;
  message: string;
  category: AgentRunFailureCategory;
}

export interface AgentRun {
  id: AgentRunId;
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  ownerUserId: string;
  inputMessageId: MessageId;
  agentName: string;
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
  leaseExpiresAt?: ISODateString;
  heartbeatAt?: ISODateString;
}

export interface ActiveRunSummary {
  id: AgentRunId;
  conversationId: ConversationId;
  agentName: string;
  status: Extract<
    AgentRunStatus,
    "queued" | "running" | "waiting_for_permission" | "cancelling"
  >;
  startedAt: ISODateString;
  updatedAt: ISODateString;
  lastSequence: number;
}

export interface AgentRunProjection {
  runId: AgentRunId;
  lastSequence: number;
  status: AgentRunStatus;
  text: string;
  reasoning: Array<{
    id: string;
    text: string;
    open: boolean;
  }>;
  activeToolCalls: Array<{
    toolCallId: ToolCallId;
    toolName: string;
    input?: unknown;
    state:
      | "input_available"
      | "waiting_for_permission"
      | "output_available"
      | "output_error";
    output?: unknown;
    errorText?: string;
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

export type AgentRuntimeCommand =
  | {
      type: "tool_permission_decision";
      toolCallId: ToolCallId;
      approved: boolean;
      reason?: string;
    }
  | {
      type: "continue";
    };

export type AgentRuntimeEvent =
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
      type: "tool_call_started";
      runId: AgentRunId;
      sequence: number;
      createdAt: ISODateString;
      toolCallId: ToolCallId;
      toolName: string;
      input: unknown;
    }
  | {
      type: "tool_permission_requested";
      runId: AgentRunId;
      sequence: number;
      createdAt: ISODateString;
      toolCallId: ToolCallId;
      toolName: string;
      reason: string;
      preview?: JsonObject;
    }
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
  start(
    input: StartAgentRunInput,
    context: RuntimeCallContext
  ): Promise<AgentRunHandle>;
  observe(
    runId: AgentRunId,
    context: RuntimeCallContext,
    options?: AgentRuntimeObserveOptions
  ): AsyncIterable<AgentRuntimeEvent>;
  getStatus(
    runId: AgentRunId,
    context: RuntimeCallContext
  ): Promise<AgentRunStatus>;
  resume(
    runId: AgentRunId,
    command: AgentRuntimeCommand,
    context: RuntimeCallContext
  ): Promise<void>;
  cancel(
    runId: AgentRunId,
    reason: string | undefined,
    context: RuntimeCallContext
  ): Promise<void>;
}

export interface CreateAgentRunInput {
  id: AgentRunId;
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  ownerUserId: string;
  inputMessageId: MessageId;
  agentName: string;
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
  claimReadyDraftAttachments?: boolean;
}

export interface PreparedConversationRunStart {
  userMessage: ChatMessage;
  run: AgentRun;
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
    input: PrepareConversationRunStartInput
  ): Promise<PreparedConversationRunStart>;
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
    ownerUserId: string;
  }): Promise<AgentRun | undefined>;
  updateAgentRunStatus(input: UpdateAgentRunStatusInput): Promise<AgentRun>;
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
    ownerUserId: string;
    afterSequence?: number;
    limit?: number;
  }): Promise<RunObservation[]>;
}
