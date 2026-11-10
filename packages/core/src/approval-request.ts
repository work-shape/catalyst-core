import {
  APPROVAL_CHECK_STATUSES,
  APPROVAL_EXECUTIONS,
  APPROVAL_REQUEST_STATUSES
} from "@work-shape/catalyst-asset-schemas";
import { AppError } from "./errors";
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
  /**
   * The one person the request is addressed to: the person a confirmation in the Inbox acts
   * for (OP-4b). Only they see, count and decide it, whatever rights anyone else holds. A
   * request without one is decided by the holders of its kind's right.
   */
  addresseeUserId?: string;
  /**
   * The requester held the right that decides it when they filed it. While it is pending it is
   * listed and counted in To decide for the requester alone; the other holders of the right
   * still decide it, and list it only when they ask for the requests others may decide
   * themselves. Who may decide it is not changed by this.
   */
  requesterDecides?: true;
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

/** Why a transition of a request was refused: another transaction holds the request now. */
const APPROVAL_REQUEST_BUSY = "approval_request_busy";

/** The refusal of a transition while another one holds the request. Asking again may succeed. */
export function approvalRequestBusyError(): AppError {
  return new AppError("CONFLICT", "Approval request is being decided right now", {
    reason: APPROVAL_REQUEST_BUSY
  });
}

/** Whether a transition was refused only because another one held the request at that moment. */
export function isApprovalRequestBusy(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.code === "CONFLICT" &&
    typeof error.details === "object" &&
    error.details !== null &&
    "reason" in error.details &&
    error.details.reason === APPROVAL_REQUEST_BUSY
  );
}
