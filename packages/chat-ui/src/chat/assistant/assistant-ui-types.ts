import type { AgentRunProjection } from "@work-shape/catalyst-api-client";
import type { StoredModelFallback } from "@work-shape/catalyst-core";
import { type ApprovalDecisionEvent } from "../approvals/approval-request-model";
import type { PlatformFailure } from "../platform-report/platform-report-model";

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
  /** The run switched to its binding's fallback, which wrote the answer. */
  modelFallback?: StoredModelFallback;
  approvalDecision?: AssistantUiApprovalDecision;
  /** A tool of the finished run failed for a platform reason (PLATFORM-REPORT). */
  platformFailure?: PlatformFailure;
}

/** An Approval Request decision in the history: a status line, never a chat message. */
export interface AssistantUiApprovalDecision extends ApprovalDecisionEvent {
  /** The thread holds several proposals, so the line has to say which one it means. */
  ambiguous: boolean;
}

export interface AssistantUiMessageMetadata {
  custom?: AssistantUiMessageCustomMetadata;
}
