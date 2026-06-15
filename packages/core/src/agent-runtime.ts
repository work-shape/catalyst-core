import type { AgentRunId, ConversationId, MessageId, ToolCallId } from "./ids";
import type { JsonObject } from "./json";
import type { ISODateString } from "./time";
import type { ManagedFileRef } from "./files";
import type { AttachmentManifest } from "./files";
import type { RuntimeCallContext } from "./identity";
import type { ToolExecutionResult } from "./tool-execution";

export interface StartAgentRunInput {
  agentName: string;
  conversationId: ConversationId;
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
  | "running"
  | "waiting_for_permission"
  | "completed"
  | "cancelled"
  | "failed";

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
      };
    };

export interface AgentRuntime {
  start(
    input: StartAgentRunInput,
    context: RuntimeCallContext
  ): Promise<AgentRunHandle>;
  observe(
    runId: AgentRunId,
    context: RuntimeCallContext
  ): AsyncIterable<AgentRuntimeEvent>;
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
