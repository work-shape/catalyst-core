import type {
  ApprovalCheckResult,
  ApprovalRequest,
  ApprovalRequestDecision,
  ApprovalRequestStatus
} from "./approval-request";
import type { StorePage } from "./paging";
import type { ClientInstanceId, ConversationId } from "./ids";
import type { AgentRunWriteFence, AuthenticatedUser } from "./identity";
import type { JsonObject } from "./json";
import type { ActorAccess, Permission, PlatformAction } from "./permissions";
import type { JobsStore } from "./jobs";
import type { OperationRunStore } from "./operation-runs";

export * from "./approval-request";

/**
 * The stores a decision reaches inside its own transaction: what a kind reads and writes
 * through them commits or rolls back with the decision. It names the stores a kind needs
 * there today; `PlatformStores` bound to the transaction satisfies it.
 */
export interface ApprovalTransactionStores {
  jobs: JobsStore;
  operationRuns: OperationRunStore;
}

/**
 * Who a preview is rendered for. The workflow makes one for each of its calls, so every row of
 * a list is given the same one and a kind can keep for the next row what it read for the first.
 */
export interface ApprovalPreviewViewer {
  /** What the person who reads the request may do. A kind asks it before it shows more. */
  access: ActorAccess;
  /** The request is one row of a list. A kind then reads nothing that a row does not show. */
  inList: boolean;
}

export interface ApprovalRequestContext {
  clientInstanceId: ClientInstanceId;
  requestId: string;
  correlationId: string;
  origin?: ApprovalRequest["origin"];
  status?: ApprovalRequestStatus;
  summary?: string;
  /**
   * The stores bound to the transaction that decides the request. Given to `isStale`,
   * `isApplied`, `apply` and `declined`. What a kind reads and writes through them commits or
   * rolls back with the decision. A kind that uses nothing else there takes no second
   * connection while the request is locked.
   */
  transaction?: ApprovalTransactionStores;
  /** Given to `preview` alone. */
  viewer?: ApprovalPreviewViewer;
}

/** What a kind says about a request that can no longer apply. */
export interface ApprovalStaleness {
  /** Kept as the request's `applyResult`: why nothing was applied. */
  result: JsonObject;
  /**
   * True where the decision came too late to count, such as after the request expired. The
   * request then ends without a decision and names nobody who decided it.
   */
  undecided?: boolean;
}

/** How many requests may be pending when one more is filed. */
export interface ApprovalRequestPendingLimits {
  /** Pending requests of the kind by the same requester. */
  perRequester?: number;
  /** Pending requests of the kind across the instance. */
  perKind?: number;
}

export interface ApprovalRequestHandler<TPayload extends JsonObject = JsonObject> {
  kind: string;
  /** The right of who decides a request of this kind and sees it among the requests to decide. */
  requiredPermission: Permission | PlatformAction;
  validate(payload: JsonObject): TPayload;
  /** Proposed new content only; the workflow adds the request summary. */
  checkContent?(payload: TPayload): string;
  revert?(
    request: ApprovalRequest,
    user: AuthenticatedUser,
    context: ApprovalRequestContext
  ): Promise<JsonObject>;
  preview(payload: TPayload, context: ApprovalRequestContext): Promise<JsonObject>;
  isStale(payload: TPayload, context: ApprovalRequestContext): Promise<boolean | ApprovalStaleness>;
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
  /**
   * Called while a pending request is ended without an approval: rejected, sent back for
   * changes or withdrawn. A kind whose request holds something open ends it here. A throw
   * leaves the request pending. Takes the stored payload, so it must not require a valid one.
   */
  declined?(
    payload: JsonObject,
    decision: ApprovalRequestDecision,
    context: ApprovalRequestContext
  ): Promise<void>;
  /**
   * What is kept of the payload once the request has ended without a change that still has to
   * run. A kind whose payload holds what only the decision needed removes it here. Takes the
   * stored payload, so it must not require a valid one.
   */
  endedPayload?(payload: JsonObject): JsonObject;
}

export type ApprovalRequestHandlerRegistry = ReadonlyMap<string, ApprovalRequestHandler>;

export interface ApprovalRequestOutcome {
  status: Exclude<ApprovalRequestStatus, "pending">;
  decision?: ApprovalRequest["decision"];
  applyResult?: JsonObject;
  reversion?: ApprovalRequest["reversion"];
  /** Replaces the stored payload. Without it the payload stays as it is. */
  payload?: JsonObject;
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
    > & {
      checks?: ApprovalCheckResult[];
      /** Given when an Agent Run creates the request: refused once the run lost its lease. */
      runFence?: AgentRunWriteFence;
      /**
       * Counted and inserted under one lock per instance and kind, so no two requests filed
       * at the same moment both pass a limit. One more than a limit is refused as
       * `RATE_LIMITED` with `details.limit` naming it: `requester` or `kind`.
       */
      pendingLimits?: ApprovalRequestPendingLimits;
    }
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
    /** Only the requests whose payload has this top-level key. */
    payloadKey?: string;
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
   * The lock is not waited for: while one decision of a request is being made, every other
   * one is refused with CONFLICT at once and holds no connection.
   * A failed resolve leaves it pending. `stores` are bound to the transaction of the
   * transition: what resolve does through them commits or rolls back with it. External
   * handler effects must be idempotent by requestId: they cannot be rolled back with this
   * store's transaction.
   * Persist the decision message in the same transaction as the transition when
   * its origin conversation is still active. Do not recreate deleted history.
   */
  transitionPendingApprovalRequest(input: {
    clientInstanceId: ClientInstanceId;
    requestId: string;
    resolve(
      request: ApprovalRequest,
      stores: ApprovalTransactionStores
    ): Promise<ApprovalRequestOutcome>;
  }): Promise<ApprovalRequest>;
  /**
   * Same exclusive compare-and-set guarantee as the pending transition, for revert and for a
   * kind that records what became of an approved change that ran after the decision.
   */
  transitionApprovedApprovalRequest(input: {
    clientInstanceId: ClientInstanceId;
    requestId: string;
    resolve(
      request: ApprovalRequest,
      stores: ApprovalTransactionStores
    ): Promise<ApprovalRequestOutcome>;
  }): Promise<ApprovalRequest>;
  /**
   * Replaces the payload of a request that is not pending, for a kind's cleanup of what an
   * ended request should no longer keep. False when the request is pending or gone.
   */
  replaceEndedApprovalRequestPayload(input: {
    clientInstanceId: ClientInstanceId;
    requestId: string;
    payload: JsonObject;
  }): Promise<boolean>;
}

export interface ApprovalRequestCreator {
  createRequest(
    user: AuthenticatedUser,
    /** `runFence` where an Agent Run files the request: refused once the run lost its lease. */
    context: { correlationId: string; runFence?: AgentRunWriteFence },
    command: Pick<ApprovalRequest, "kind" | "summary" | "payload" | "origin"> & {
      pendingLimits?: ApprovalRequestPendingLimits;
    }
  ): Promise<ApprovalRequest>;
}
