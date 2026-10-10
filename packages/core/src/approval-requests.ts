import type { StorePage } from "./paging";
import type { AgentRunId, ClientInstanceId, ConversationId, ToolCallId } from "./ids";
import type { AuthenticatedUser } from "./identity";
import type { JsonObject } from "./json";
import type { Permission } from "./permissions";
import type { ToolPermissionDecision } from "./tool-execution";

export type ApprovalRequestStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "changes_requested"
  | "superseded"
  | "withdrawn"
  | "reverted";

export interface ApprovalCheckResult {
  id: string;
  status: "passed" | "warned" | "blocked";
  message: string;
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
  decision?: ToolPermissionDecision & { decidedByLabel: string; comment?: string };
  reversion?: { revertedBy: string; revertedByLabel: string; revertedAt: string };
  checks: ApprovalCheckResult[];
  applyResult?: JsonObject;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalRequestContext {
  clientInstanceId: ClientInstanceId;
  requestId: string;
  correlationId: string;
  origin?: ApprovalRequest["origin"];
  status?: ApprovalRequestStatus;
  summary?: string;
}

export interface ApprovalRequestHandler<TPayload extends JsonObject = JsonObject> {
  kind: string;
  requiredPermission: Permission;
  validate(payload: JsonObject): TPayload;
  /** Proposed new content only; the workflow adds the request summary. */
  checkContent?(payload: TPayload): string;
  revert?(
    request: ApprovalRequest,
    user: AuthenticatedUser,
    context: ApprovalRequestContext
  ): Promise<JsonObject>;
  preview(payload: TPayload, context: ApprovalRequestContext): Promise<JsonObject>;
  isStale(payload: TPayload, context: ApprovalRequestContext): Promise<boolean>;
  /**
   * True when this request's change is already live because apply committed but recording the
   * outcome failed. Takes the stored payload, so it must not require a valid one.
   */
  isApplied?(payload: JsonObject, context: ApprovalRequestContext): Promise<boolean>;
  apply(
    payload: TPayload,
    approver: AuthenticatedUser,
    context: ApprovalRequestContext
  ): Promise<JsonObject>;
}

export type ApprovalRequestHandlerRegistry = ReadonlyMap<string, ApprovalRequestHandler>;

export interface ApprovalRequestOutcome {
  status: Exclude<ApprovalRequestStatus, "pending">;
  decision?: ApprovalRequest["decision"];
  applyResult?: JsonObject;
  reversion?: ApprovalRequest["reversion"];
}

export interface ApprovalDecisionStore {
  /** Idempotently records a decided request in its active origin conversation.
   * Internal operation: approval authorization does not grant conversation access.
   */
  appendApprovalDecision(request: ApprovalRequest): Promise<void>;
}

export interface ApprovalRequestStore {
  createApprovalRequest(
    input: Pick<
      ApprovalRequest,
      "clientInstanceId" | "kind" | "summary" | "payload" | "requestedBy" | "origin"
    > & { checks?: ApprovalCheckResult[] }
  ): Promise<ApprovalRequest>;
  getApprovalRequest(input: {
    clientInstanceId: ClientInstanceId;
    requestId: string;
  }): Promise<ApprovalRequest | undefined>;
  /** Newest first with an exclusive createdAt/id cursor when paging. */
  listApprovalRequests(input: {
    clientInstanceId: ClientInstanceId;
    kinds: readonly string[];
    status?: ApprovalRequestStatus;
    /** Every status but this one. */
    excludeStatus?: ApprovalRequestStatus;
    /** Only the requests this person made. */
    requestedById?: string;
    /** Only the requests changed at or after this instant. */
    updatedSince?: Date;
    conversationId?: ConversationId;
    page?: StorePage;
  }): Promise<ApprovalRequest[]>;
  countPendingApprovalRequests(input: {
    clientInstanceId: ClientInstanceId;
    kinds: readonly string[];
  }): Promise<number>;
  /** How many requests of these kinds one person made: those still pending, and all of them. */
  countOwnApprovalRequests(input: {
    clientInstanceId: ClientInstanceId;
    kinds: readonly string[];
    requestedById: string;
  }): Promise<{ pending: number; total: number }>;
  /** Exclusively lock a pending request before resolve; otherwise throw CONFLICT.
   * A failed resolve leaves it pending. External handler effects must be idempotent
   * by requestId: they cannot be rolled back with this store's transaction.
   * Persist the decision message in the same transaction as the transition when
   * its origin conversation is still active. Do not recreate deleted history.
   */
  transitionPendingApprovalRequest(input: {
    clientInstanceId: ClientInstanceId;
    requestId: string;
    resolve(request: ApprovalRequest): Promise<ApprovalRequestOutcome>;
  }): Promise<ApprovalRequest>;
  /** Same exclusive compare-and-set guarantee as the pending transition, for revert. */
  transitionApprovedApprovalRequest(input: {
    clientInstanceId: ClientInstanceId;
    requestId: string;
    resolve(request: ApprovalRequest): Promise<ApprovalRequestOutcome>;
  }): Promise<ApprovalRequest>;
}

export interface ApprovalRequestCreator {
  createRequest(
    user: AuthenticatedUser,
    context: { correlationId: string },
    command: Pick<ApprovalRequest, "kind" | "summary" | "payload" | "origin">
  ): Promise<ApprovalRequest>;
}
