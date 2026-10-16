import {
  APPROVAL_CHECK_STATUSES,
  APPROVAL_EXECUTIONS,
  APPROVAL_REQUEST_STATUSES
} from "@work-shape/catalyst-asset-schemas";
import type { AuthenticatedUser } from "./identity";
import type { AgentRunId, ClientInstanceId, ConversationId, ToolCallId } from "./ids";
import type { JsonObject } from "./json";
import type { ISODateString } from "./time";

// An Approval Request as data: what is stored and shown. Who handles and stores one is in
// `approval-requests.ts`, which a module that only reads a request does not need to import.

export type ApprovalRequestStatus = (typeof APPROVAL_REQUEST_STATUSES)[number];

export interface ApprovalCheckResult {
  id: string;
  status: (typeof APPROVAL_CHECK_STATUSES)[number];
  message: string;
}

/** What a person answered to a request, and when. */
export interface ApprovalRequestDecision {
  approved: boolean;
  decidedBy: string;
  decidedByLabel: string;
  decidedAt: ISODateString;
  reason?: string;
  comment?: string;
}

export interface ApprovalRequest {
  id: string;
  clientInstanceId: ClientInstanceId;
  kind: string;
  summary: string;
  payload: JsonObject;
  requestedBy: Pick<AuthenticatedUser, "id" | "displayLabel">;
  origin?: {
    conversationId: ConversationId;
    agentRunId: AgentRunId;
    toolCallId: ToolCallId;
    agentName: string;
  };
  status: ApprovalRequestStatus;
  decision?: ApprovalRequestDecision;
  reversion?: { revertedBy: string; revertedByLabel: string; revertedAt: string };
  checks: ApprovalCheckResult[];
  applyResult?: JsonObject;
  createdAt: string;
  updatedAt: string;
}

/**
 * How a kind reports what became of an approved change that runs after the decision, as the
 * field `execution` of the request's `applyResult`. `queued` is an approval whose change has
 * not ended yet; the thread is told once it has. A kind whose change is applied with the
 * decision leaves the field out.
 */
export { APPROVAL_EXECUTIONS } from "@work-shape/catalyst-asset-schemas";

export type ApprovalExecution = (typeof APPROVAL_EXECUTIONS)[number];

export function approvalExecutionOf(
  request: Pick<ApprovalRequest, "applyResult">
): ApprovalExecution | undefined {
  const value = request.applyResult?.execution;
  return APPROVAL_EXECUTIONS.find((execution) => execution === value);
}
