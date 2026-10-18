import { apiOperations } from "@work-shape/catalyst-api-contract";
import type { LocaleCode, StorePage } from "@work-shape/catalyst-core";
import {
  AppError,
  GRANT_SCOPE_KINDS,
  auditActorFromUser,
  getSubjectUserId,
  hasAuthScope,
  operationDenialError,
  type AccessResource,
  type ActorAccess,
  type ApprovalPreviewViewer,
  type ApprovalRequest,
  type ApprovalRequestContext,
  type ApprovalRequestCreator,
  type ApprovalRequestDecision,
  type ApprovalRequestHandler,
  type ApprovalRequestHandlerRegistry,
  type ApprovalRequestPendingLimits,
  type ApprovalRequestStatus,
  type ApprovalRequestStore,
  type ApprovalSubjectKind,
  type AuditRecorder,
  type AuthenticatedUser,
  type ClientInstanceId,
  type JsonObject,
  type OperationBeforeEvent,
  type ApprovalTransactionStores,
  type RuntimeCallContext
} from "@work-shape/catalyst-core";
import { guardrailDenial } from "@work-shape/catalyst-tool-execution";
import type { GuardrailRunner } from "../guardrails/guardrail-runner";

/** Scopes the approval routes require; the view flags use the same ones. */
const APPROVAL_DECIDE_AUTH_SCOPE = "governance:write";
const APPROVAL_WITHDRAW_AUTH_SCOPE = "conversation:write";

/** How far back the list of decided requests reaches. Older decisions stay in the audit trail. */
const DECIDED_LIST_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** The decided list and its count: everything no longer pending that changed inside the window. */
function decidedListFilter(): { excludeStatus: "pending"; updatedSince: Date } {
  return { excludeStatus: "pending", updatedSince: new Date(Date.now() - DECIDED_LIST_WINDOW_MS) };
}

type CallContext = Pick<RuntimeCallContext, "correlationId"> &
  Partial<Omit<RuntimeCallContext, "user" | "clientInstanceId" | "correlationId">>;

export interface ApprovalRequestWorkflowOptions {
  clientInstanceId: ClientInstanceId;
  store: ApprovalRequestStore;
  handlers: ApprovalRequestHandlerRegistry;
  auditRecorder: AuditRecorder;
  /** Runs the guardrails of `approval_request.before_create` before a request is filed. */
  guardrails?: GuardrailRunner;
  /**
   * The language of the person who opens a request: their account's, else the one their
   * request names, else the instance's. A kind words its review in it. Absent: the request's.
   */
  readerLocale?(userId: string, requested: LocaleCode | undefined): Promise<LocaleCode>;
  onDecided?(request: ApprovalRequest): void | Promise<void>;
}

export interface ApprovalRequestView extends ApprovalRequest {
  preview: JsonObject;
  canDecide: boolean;
  canWithdraw: boolean;
  canRevert: boolean;
}

export class ApprovalRequestWorkflow implements ApprovalRequestCreator {
  constructor(private readonly options: ApprovalRequestWorkflowOptions) {}

  async createRequest(
    user: AuthenticatedUser,
    context: CallContext,
    command: Pick<
      ApprovalRequest,
      "kind" | "summary" | "payload" | "origin" | "addresseeUserId"
    > & {
      pendingLimits?: ApprovalRequestPendingLimits;
    }
  ): Promise<ApprovalRequest> {
    this.assertClientInstance(user);
    const handler = this.handler(command.kind);
    const payload = handler.validate(command.payload);
    if (!command.summary.trim()) {
      throw new AppError("VALIDATION_FAILED", "Approval request summary is required");
    }
    const checks =
      (await this.options.guardrails?.check(
        {
          event: "approval_request.before_create",
          subjectKind: command.kind,
          fields: () => {
            const newContent = handler.checkContent?.(payload);
            return newContent === undefined ? undefined : { summary: command.summary, newContent };
          },
          ...(command.origin ? { origin: command.origin } : {})
        },
        {
          ...context,
          user,
          clientInstanceId: this.options.clientInstanceId
        }
      )) ?? [];
    const blocked = checks.filter((check) => check.status === "blocked");
    if (blocked.length > 0) {
      throw new AppError(
        "VALIDATION_FAILED",
        `Approval request blocked: ${blocked.map((check) => check.message).join("; ")}`
      );
    }
    const request = await this.options.store.createApprovalRequest({
      ...command,
      payload,
      checks,
      clientInstanceId: this.options.clientInstanceId,
      requestedBy: { id: user.id, displayLabel: user.displayLabel },
      // A request that an Agent Run proposes is created only while the run holds its lease.
      runFence: context.runFence
    });
    await this.record(user, context, "approval_request.created", request);
    return request;
  }

  async getRequest(
    user: AuthenticatedUser,
    access: ActorAccess,
    context: CallContext,
    requestId: string
  ): Promise<ApprovalRequestView> {
    const request = await this.visibleRequest(user, access, requestId);
    const locale = this.options.readerLocale
      ? await this.options.readerLocale(user.id, context.locale)
      : context.locale;
    return this.view(user, { access, inList: false, ...(locale ? { locale } : {}) }, context, request);
  }

  async listRequests(
    user: AuthenticatedUser,
    access: ActorAccess,
    context: CallContext,
    filter: { status?: ApprovalRequestStatus; scope?: "decided"; page?: StorePage } = {}
  ): Promise<ApprovalRequestView[]> {
    const { kinds, subjectKinds } = await this.reviewable(user, access);
    // A person without any kind's right reads the confirmations addressed to them, and
    // nothing else; one who has none is refused the queue as before (OP-4b).
    if (
      kinds.length === 0 &&
      subjectKinds.length === 0 &&
      !(await this.hasAddressedRequests(user))
    ) {
      throw new AppError("FORBIDDEN", "Approval review requires a registered kind's permission");
    }
    const { scope, ...storeFilter } = filter;
    const requests = await this.options.store.listApprovalRequests({
      clientInstanceId: this.options.clientInstanceId,
      kinds,
      subjectKinds,
      reader: this.reader(user),
      ...storeFilter,
      ...(scope === "decided" ? decidedListFilter() : {})
    });
    // One viewer for the page: what a kind reads for one row it does not read for the next.
    const viewer: ApprovalPreviewViewer = { access, inList: true };
    return Promise.all(requests.map((request) => this.view(user, viewer, context, request)));
  }

  /**
   * The requests the caller made, in any status. It needs no review permission: a request is
   * visible to the person who made it, unless it is addressed to somebody else. A request
   * addressed to a person is theirs alone, its requester included (OP-4b): a notice is read by
   * its addressee, never by its sender.
   */
  async listOwnRequests(
    user: AuthenticatedUser,
    access: ActorAccess,
    context: CallContext,
    filter: { page?: StorePage } = {}
  ): Promise<ApprovalRequestView[]> {
    this.assertClientInstance(user);
    const requests = await this.options.store.listApprovalRequests({
      clientInstanceId: this.options.clientInstanceId,
      kinds: this.registeredKinds(),
      requestedById: user.id,
      reader: this.reader(user),
      ...filter
    });
    // One viewer for the page: what a kind reads for one row it does not read for the next.
    const viewer: ApprovalPreviewViewer = { access, inList: true };
    return Promise.all(requests.map((request) => this.view(user, viewer, context, request)));
  }

  async pendingCount(
    user: AuthenticatedUser,
    access: ActorAccess
  ): Promise<{
    count: number;
    canReview: boolean;
    decided: number;
    mine: { pending: number; total: number };
  }> {
    const { kinds, subjectKinds } = await this.reviewable(user, access);
    const reader = this.reader(user);
    const [count, decided, mine] = await Promise.all([
      this.options.store.countPendingApprovalRequests({
        clientInstanceId: this.options.clientInstanceId,
        kinds,
        subjectKinds,
        reader
      }),
      // What the decided list holds for this person: the same kinds and the same filter.
      this.options.store.countApprovalRequests({
        clientInstanceId: this.options.clientInstanceId,
        kinds,
        subjectKinds,
        reader,
        ...decidedListFilter()
      }),
      this.options.store.countOwnApprovalRequests({
        clientInstanceId: this.options.clientInstanceId,
        kinds: this.registeredKinds(),
        requestedById: user.id
      })
    ]);
    // A confirmation addressed to the person is theirs to review whatever rights they hold.
    return {
      count,
      canReview: kinds.length > 0 || subjectKinds.length > 0 || count + decided > 0,
      decided,
      mine
    };
  }

  async decideRequest(
    user: AuthenticatedUser,
    access: ActorAccess,
    context: CallContext,
    command: {
      requestId: string;
      decision: "approve" | "reject" | "request_changes";
      comment?: string;
    }
  ): Promise<ApprovalRequest> {
    const request = await this.visibleRequest(user, access, command.requestId);
    const handler = this.handler(request.kind);
    // A request addressed to a person is theirs to decide, whatever rights they hold; only
    // they reach it here.
    if (request.addresseeUserId === undefined) {
      access.require(handler.requiredPermission, resourceOfRequest(handler, request));
    } else if (command.decision === "request_changes") {
      throw new AppError("VALIDATION_FAILED", "A confirmation is allowed or denied");
    }
    const comment = command.comment?.trim();
    if (command.decision === "request_changes" && !comment) {
      throw new AppError("VALIDATION_FAILED", "Requesting changes requires a comment");
    }
    const updated = await this.options.store.transitionPendingApprovalRequest({
      clientInstanceId: this.options.clientInstanceId,
      requestId: request.id,
      resolve: async (pending, stores) => {
        const decision = {
          approved: command.decision === "approve",
          decidedBy: user.id,
          decidedByLabel: user.displayLabel,
          decidedAt: new Date().toISOString(),
          ...(comment ? { comment } : {})
        };
        const handlerContext = this.handlerContext(pending, context, stores);
        if (command.decision !== "approve") {
          await this.assertNotApplied(pending, handlerContext);
          await this.endWithoutApproval(pending, decision, handlerContext);
          return {
            status: command.decision === "reject" ? "rejected" : "changes_requested",
            decision,
            ...this.endedPayload(pending)
          };
        }
        const payload = handler.validate(pending.payload);
        const stale = await handler.isStale(payload, handlerContext);
        if (stale) {
          // A kind that says why keeps the reason, and a decision that came too late to
          // count is not recorded as one.
          return {
            status: "superseded",
            ...(typeof stale === "object" ? { applyResult: stale.result } : {}),
            ...(typeof stale === "object" && stale.undecided ? {} : { decision }),
            ...this.endedPayload(pending)
          };
        }
        const refusal = await this.guardrailRefusal(
          (await handler.applyEvents?.(payload, handlerContext)) ?? [],
          pending,
          user,
          context,
          "approval"
        );
        if (refusal) {
          // Approved, and not applied: the item keeps why, as a held call's refusal does.
          return {
            status: "superseded",
            decision,
            applyResult: {
              execution: "refused",
              error: { code: refusal.code, message: refusal.message }
            },
            ...this.endedPayload(pending)
          };
        }
        const applyResult = await handler.apply(payload, user, handlerContext);
        return { status: "approved", decision, applyResult };
      }
    });
    await this.record(user, context, "approval_request.decided", updated);
    await this.options.onDecided?.(updated);
    return updated;
  }

  async withdrawRequest(
    user: AuthenticatedUser,
    access: ActorAccess,
    context: CallContext,
    requestId: string
  ): Promise<ApprovalRequest> {
    const request = await this.visibleRequest(user, access, requestId);
    if (request.requestedBy.id !== user.id) {
      throw new AppError("FORBIDDEN", "Only the requester can withdraw an approval request");
    }
    if (request.addresseeUserId !== undefined) {
      throw new AppError("CONFLICT", "A confirmation in your Inbox is answered with Allow or Deny");
    }
    const updated = await this.options.store.transitionPendingApprovalRequest({
      clientInstanceId: this.options.clientInstanceId,
      requestId,
      resolve: async (pending, stores) => {
        const handlerContext = this.handlerContext(pending, context, stores);
        await this.assertNotApplied(pending, handlerContext);
        const decision = {
          approved: false,
          decidedBy: user.id,
          decidedByLabel: user.displayLabel,
          decidedAt: new Date().toISOString()
        };
        await this.endWithoutApproval(pending, decision, handlerContext);
        return { status: "withdrawn", decision, ...this.endedPayload(pending) };
      }
    });
    await this.record(user, context, "approval_request.withdrawn", updated);
    await this.options.onDecided?.(updated);
    return updated;
  }

  async revertRequest(
    user: AuthenticatedUser,
    access: ActorAccess,
    context: CallContext,
    requestId: string
  ): Promise<ApprovalRequest> {
    const request = await this.visibleRequest(user, access, requestId);
    const handler = this.handler(request.kind);
    access.require(handler.requiredPermission, resourceOfRequest(handler, request));
    const revert = handler.revert?.bind(handler);
    if (!revert)
      throw new AppError("CONFLICT", "This approval request kind does not support revert");
    const updated = await this.options.store.transitionApprovedApprovalRequest({
      clientInstanceId: this.options.clientInstanceId,
      requestId,
      resolve: async (approved) => {
        const handlerContext = this.handlerContext(approved, context);
        // The revision a revert writes back may predate a guardrail: it is read like a write.
        const refusal = await this.guardrailRefusal(
          (await handler.revertEvents?.(approved, handlerContext)) ?? [],
          approved,
          user,
          context,
          "revert"
        );
        if (refusal) throw refusal;
        await revert(approved, user, handlerContext);
        return {
          status: "reverted",
          decision: approved.decision,
          applyResult: approved.applyResult,
          reversion: {
            revertedBy: user.id,
            revertedByLabel: user.displayLabel,
            revertedAt: new Date().toISOString()
          }
        };
      }
    });
    await this.record(user, context, "approval_request.reverted", updated);
    await this.options.onDecided?.(updated);
    return updated;
  }

  /**
   * The refusal of a change a guardrail blocks, asked about the change as the request would
   * write it: an approved change before `apply`, or a revert before `revert`. A hold is
   * answered by the person who decides, who holds the right to approve the kind.
   */
  private async guardrailRefusal(
    events: readonly OperationBeforeEvent[],
    request: ApprovalRequest,
    user: AuthenticatedUser,
    context: CallContext,
    asked: "approval" | "revert"
  ): Promise<AppError | undefined> {
    const { guardrails } = this.options;
    if (!guardrails) return undefined;
    const { origin } = request;
    for (const event of events) {
      const answers = await guardrails.answer(
        {
          event: event.name,
          subject: event.subject,
          match:
            event.name === "operation.before_call"
              ? { operation: event.subject.name }
              : {
                  kind: event.subject.kind,
                  // An approved change is the agent's that proposed it, as when it was
                  // proposed; a revert is the person's who makes it.
                  ...(asked === "revert"
                    ? { origin: "user" }
                    : origin
                      ? { origin: "agent", agent: origin.agentName }
                      : {})
                },
          fields: event.checkable
        },
        {
          correlationId: context.correlationId,
          userId: getSubjectUserId(user),
          ...(origin ? { conversationId: origin.conversationId } : {}),
          ...(context.deadline ? { deadline: context.deadline } : {}),
          ...(context.signal ? { signal: context.signal } : {}),
          // At the approval the change is asked again: its other answers were kept when the
          // request was filed. A revert is a new write, whose answers are all kept.
          ...(asked === "approval" ? { repeated: true } : {})
        }
      );
      if (answers.some((answer) => answer.outcome === "block")) {
        return operationDenialError(
          guardrailDenial(
            [{ outcome: "block", guardrails: answers, subject: event.subject }],
            event.name
          )
        );
      }
    }
    return undefined;
  }

  /**
   * Apply may have committed before recording the approval failed. Such a request must not end
   * as rejected or withdrawn while its change is live; approving it again records the outcome.
   */
  private async assertNotApplied(
    pending: ApprovalRequest,
    context: ApprovalRequestContext
  ): Promise<void> {
    const handler = this.options.handlers.get(pending.kind);
    if (await handler?.isApplied?.(pending.payload, context)) {
      throw new AppError(
        "CONFLICT",
        "This request's change is already applied; approve it to record the outcome"
      );
    }
  }

  /** Tells the kind that its request ends without an approval, inside the transition. */
  private async endWithoutApproval(
    pending: ApprovalRequest,
    decision: ApprovalRequestDecision,
    context: ApprovalRequestContext
  ): Promise<void> {
    await this.options.handlers.get(pending.kind)?.declined?.(pending.payload, decision, context);
  }

  /** What the kind keeps of the payload of a request that ends here, where it says so. */
  private endedPayload(pending: ApprovalRequest): { payload?: JsonObject } {
    const payload = this.options.handlers.get(pending.kind)?.endedPayload?.(pending.payload);
    return payload ? { payload } : {};
  }

  private async visibleRequest(
    user: AuthenticatedUser,
    access: ActorAccess,
    requestId: string
  ): Promise<ApprovalRequest> {
    this.assertClientInstance(user);
    const request = await this.options.store.getApprovalRequest({
      clientInstanceId: this.options.clientInstanceId,
      requestId
    });
    const handler = request ? this.options.handlers.get(request.kind) : undefined;
    if (
      !request ||
      // A request addressed to a person is theirs alone: to anyone else it does not exist,
      // an instance admin and a holder of the kind's right included (OP-4b).
      (request.addresseeUserId !== undefined
        ? request.addresseeUserId !== user.id
        : request.requestedBy.id !== user.id &&
          (!handler ||
            !access.authorize(handler.requiredPermission, resourceOfRequest(handler, request))
              .allowed))
    ) {
      throw new AppError("NOT_FOUND", "Approval request was not found");
    }
    return request;
  }

  /** Whether any request, in any status, is addressed to the caller. */
  private async hasAddressedRequests(user: AuthenticatedUser): Promise<boolean> {
    const count = await this.options.store.countApprovalRequests({
      clientInstanceId: this.options.clientInstanceId,
      kinds: [],
      reader: this.reader(user)
    });
    return count > 0;
  }

  /** Who reads a list: requests addressed to somebody are listed to that person alone. */
  private reader(user: AuthenticatedUser): { userId: string; addressedKinds: string[] } {
    return { userId: user.id, addressedKinds: this.registeredKinds() };
  }

  private async view(
    user: AuthenticatedUser,
    viewer: ApprovalPreviewViewer,
    context: CallContext,
    request: ApprovalRequest
  ): Promise<ApprovalRequestView> {
    const { access } = viewer;
    const handler = this.handler(request.kind);
    const canDecideWithToken = hasAuthScope(user, APPROVAL_DECIDE_AUTH_SCOPE);
    // A request addressed to a person is decided by that person, and by the right of nobody.
    const decides =
      request.addresseeUserId !== undefined
        ? request.addresseeUserId === user.id
        : access.authorize(handler.requiredPermission, resourceOfRequest(handler, request)).allowed;
    return {
      ...request,
      preview: await handler.preview(handler.validate(request.payload), {
        ...this.handlerContext(request, context),
        viewer
      }),
      // A flag is true only if the route would also accept the caller's token scopes.
      canRevert:
        request.status === "approved" && Boolean(handler.revert) && canDecideWithToken && decides,
      canDecide: request.status === "pending" && canDecideWithToken && decides,
      canWithdraw:
        request.status === "pending" &&
        request.addresseeUserId === undefined &&
        request.requestedBy.id === user.id &&
        (hasAuthScope(user, APPROVAL_WITHDRAW_AUTH_SCOPE) ||
          (user.keyScopes !== undefined &&
            hasAuthScope(user, apiOperations["approval_requests.withdraw"].personalKeyScope)))
    };
  }

  /**
   * What the caller reviews: the kinds whose right they hold on the instance, and of a kind
   * whose right is held on assets, the requests about the assets they hold it on.
   */
  private async reviewable(
    user: AuthenticatedUser,
    access: ActorAccess
  ): Promise<{ kinds: string[]; subjectKinds: ApprovalSubjectKind[] }> {
    this.assertClientInstance(user);
    const kinds: string[] = [];
    const subjectKinds: ApprovalSubjectKind[] = [];
    for (const handler of this.options.handlers.values()) {
      const permission = handler.requiredPermission;
      const onInstance = access.authorize(permission).allowed;
      if (!handler.resourceOf || !handler.reviewableSubjects) {
        if (onInstance) kinds.push(handler.kind);
        continue;
      }
      // The right on the instance covers every asset only where no deny lies on one: a list
      // and its counts read what a read of each request would, denies included.
      if (onInstance && access.denials(permission).length === 0) {
        kinds.push(handler.kind);
        continue;
      }
      if (!onInstance && !access.holdsGrantAt(permission, NARROWER_SCOPES)) continue;
      const subjects = await handler.reviewableSubjects(access);
      if (subjects.length > 0) subjectKinds.push({ kind: handler.kind, subjects });
    }
    return { kinds, subjectKinds };
  }

  /** Every kind with a handler. A request of a kind without one cannot be shown or counted. */
  private registeredKinds(): string[] {
    return [...this.options.handlers.keys()];
  }

  private handler(kind: string): ApprovalRequestHandler {
    const handler = this.options.handlers.get(kind);
    if (!handler) throw new AppError("NOT_FOUND", "Approval request kind was not found");
    return handler;
  }

  private handlerContext(
    request: ApprovalRequest,
    context: CallContext,
    /** The stores of the transaction that decides the request. */
    transaction?: ApprovalTransactionStores
  ): ApprovalRequestContext {
    return {
      ...(transaction ? { transaction } : {}),
      clientInstanceId: this.options.clientInstanceId,
      requestId: request.id,
      correlationId: context.correlationId,
      origin: request.origin,
      status: request.status,
      summary: request.summary
    };
  }

  private assertClientInstance(user: AuthenticatedUser): void {
    if (user.clientInstanceId !== this.options.clientInstanceId) {
      throw new AppError("FORBIDDEN", "User belongs to another client instance");
    }
  }

  private async record(
    user: AuthenticatedUser,
    context: CallContext,
    type: string,
    request: ApprovalRequest
  ): Promise<void> {
    await this.options.auditRecorder.record({
      type,
      status: "success",
      actor: auditActorFromUser(user),
      correlationId: context.correlationId,
      metadata: {
        requestId: request.id,
        kind: request.kind,
        status: request.status,
        ...(type === "approval_request.created" && request.checks.length > 0
          ? { checks: request.checks.map((check) => ({ id: check.id, status: check.status })) }
          : {})
      }
    });
  }
}

/** The scopes of a grant narrower than the instance. */
const NARROWER_SCOPES = GRANT_SCOPE_KINDS.filter((scope) => scope !== "instance");

/**
 * The asset a request's right is asked on, where its kind names one. A payload the kind cannot
 * read names none, and the right is asked of the instance.
 */
function resourceOfRequest(
  handler: ApprovalRequestHandler,
  request: ApprovalRequest
): AccessResource | undefined {
  if (!handler.resourceOf) return undefined;
  try {
    return handler.resourceOf(handler.validate(request.payload));
  } catch {
    return undefined;
  }
}
