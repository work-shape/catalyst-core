import type {
  ApprovalCheckResult,
  ApprovalRequest,
  ApprovalRequestDecision,
  ApprovalRequestStatus
} from "./approval-request";
import type { OperationBeforeEvent } from "./guardrail-events";
import type { StorePage } from "./paging";
import type { ClientInstanceId, ConversationId } from "./ids";
import type { AgentRunWriteFence, AuthenticatedUser } from "./identity";
import type { JsonObject } from "./json";
import type { AccessResource, ActorAccess, Permission, PlatformAction } from "./permissions";
import type { JobsStore } from "./jobs";
import type { OperationRunStore } from "./operation-runs";
import type { ConfigAssetStore } from "./config-assets";
import type { LocaleCode } from "./localization";
import type { FeedbackStore } from "./feedback";

export * from "./approval-request";

/** One further right a request asks of who decides it, and the resource it is asked on. */
export interface ApprovalFurtherRight {
  permission: Permission | PlatformAction;
  resource: AccessResource;
}

/**
 * The stores a decision reaches inside its own transaction: what a kind reads and writes
 * through them commits or rolls back with the decision. It names the stores a kind needs
 * there today; `PlatformStores` bound to the transaction satisfies it.
 */
export interface ApprovalTransactionStores {
  jobs: JobsStore;
  operationRuns: OperationRunStore;
  /** What a kind reads of the asset a request is about, such as whether it moved. */
  configAssets: Pick<ConfigAssetStore, "getConfigAsset">;
  /** The comment a `feedback_review` item marks handled, in the same transaction. */
  feedback?: Pick<FeedbackStore, "getFeedback" | "markFeedbackHandled">;
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
  /** The reader's language, for what a kind words itself. The instance's where absent. */
  locale?: LocaleCode;
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
  /** Given to `preview` alone: when an ended request was decided, where someone decided it. */
  decidedAt?: string;
  /** Given to `apply` alone: the decision being made, with the decider's comment. */
  decision?: ApprovalRequestDecision;
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
  /**
   * True for a kind its requester never reads as a request of theirs: it is not among their
   * own requests, and they cannot open or withdraw it by its id. The author of feedback sees
   * its state under the message, never the reviewer's note.
   */
  hiddenFromRequester?: boolean;
  /** The right of who decides a request of this kind and sees it among the requests to decide. */
  requiredPermission: Permission | PlatformAction;
  /**
   * The asset a request is about, for a kind whose right is held on that asset: the right is
   * then asked on it, as the evaluator resolves it there (a grant on the asset or on a scope that covers it). Left
   * out, it is asked of the instance.
   */
  resourceOf?(payload: TPayload): AccessResource;
  /**
   * Further rights one request asks of who decides it, beside `requiredPermission`, each on its
   * own resource: a joint publish asks `workflow.approve` on each Workflow it makes live
   * (DP-3). Who lacks one of them may read the request and not decide it. A payload whose
   * rights cannot be told throws: the request is then decided by nobody.
   */
  furtherPermissions?(payload: TPayload): readonly ApprovalFurtherRight[];
  /**
   * The subjects of the requests one holder may review, where the right on the instance does
   * not cover every asset for them (they hold it on some assets only, or are denied it on
   * some): what `payload.subject` holds of each request `resourceOf` admits them to. Lists and
   * counts read it, so they show what a read of each request shows. Only with `resourceOf`.
   */
  reviewableSubjects?(access: ActorAccess): Promise<readonly JsonObject[]>;
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
  /**
   * The before-events of the change `apply` makes, asked again once the request is approved
   * and before it is applied: a guardrail that was added since the request was filed reads the
   * change too. A block there ends the request unapplied with the reason; a hold is answered by
   * the approval itself.
   */
  applyEvents?(
    payload: TPayload,
    context: ApprovalRequestContext
  ): Promise<readonly OperationBeforeEvent[]>;
  apply(
    payload: TPayload,
    approver: AuthenticatedUser,
    context: ApprovalRequestContext
  ): Promise<JsonObject>;
  /**
   * The before-events of the write `revert` makes, asked before it: a revision written back
   * is read like any other write, also one written before a guardrail existed. A block refuses
   * the revert and leaves the request approved.
   */
  revertEvents?(
    request: ApprovalRequest,
    context: ApprovalRequestContext
  ): Promise<readonly OperationBeforeEvent[]>;
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

/** Which requests a list holds. The count of a list takes the same filter. */
export interface ApprovalRequestListFilter {
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
  /** Retention repair: only requests whose run exists and has ended. */
  endedRunOnly?: true;
  /** Only the requests whose payload's `subject` holds these fields with these values. */
  subjectContains?: JsonObject;
  /**
   * The person who reads the list. A request addressed to somebody is then listed only to
   * that person: one of `kinds` addressed to nobody, or one of `addressedKinds` addressed to
   * this person. Without it, requests of `kinds` are listed whoever they are addressed to,
   * for the paths of the instance itself.
   */
  reader?: { userId: string; addressedKinds: readonly string[] };
  /**
   * Beside `kinds`: requests of these kinds, addressed to nobody, whose `payload.subject`
   * holds one of the subjects with its values. The kinds a reader may review on some assets
   * only.
   */
  subjectKinds?: readonly ApprovalSubjectKind[];
}

/** The requests of one kind a reader may review: those about one of the subjects. */
export interface ApprovalSubjectKind {
  kind: string;
  subjects: readonly JsonObject[];
}

export interface ApprovalRequestStore {
  createApprovalRequest(
    input: Pick<
      ApprovalRequest,
      | "clientInstanceId"
      | "kind"
      | "summary"
      | "payload"
      | "requestedBy"
      | "origin"
      | "addresseeUserId"
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
  listApprovalRequests(
    input: ApprovalRequestListFilter & { page?: StorePage }
  ): Promise<ApprovalRequest[]>;
  /** How many requests `listApprovalRequests` answers for the same filter, read to its end. */
  countApprovalRequests(input: ApprovalRequestListFilter): Promise<number>;
  countPendingApprovalRequests(
    input: Pick<ApprovalRequestListFilter, "clientInstanceId" | "kinds" | "reader" | "subjectKinds">
  ): Promise<number>;
  /**
   * How many requests of these kinds one person made: those still pending, and all of them.
   * A request addressed to somebody else is not counted: it is the addressee's alone.
   */
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
    command: Pick<
      ApprovalRequest,
      "kind" | "summary" | "payload" | "origin" | "addresseeUserId"
    > & {
      pendingLimits?: ApprovalRequestPendingLimits;
    }
  ): Promise<ApprovalRequest>;
}
