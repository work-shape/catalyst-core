import type { AgentRunProjection } from "@work-shape/catalyst-api-client";
import { type ApprovalDecisionEvent } from "../approvals/approval-request-model";

export interface AssistantUiActiveRun {
  run: {
    id: string;
    status: string;
  };
  projection: AgentRunProjection;
}

export interface AssistantUiMessageCustomMetadata {
  source?: "active-run";
  activeRunCompleted?: boolean;
  completedRunId?: string;
  runDurationMs?: number;
  contextCompacted?: boolean;
  approvalDecision?: AssistantUiApprovalDecision;
}

/** An Approval Request decision in the history: a status line, never a chat message. */
export interface AssistantUiApprovalDecision extends ApprovalDecisionEvent {
  /** The thread holds several proposals, so the line has to say which one it means. */
  ambiguous: boolean;
}

export interface AssistantUiMessageMetadata {
  custom?: AssistantUiMessageCustomMetadata;
}
