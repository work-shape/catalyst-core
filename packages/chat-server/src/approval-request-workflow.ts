import type { StorePage } from "@vivd-catalyst/core";
import {
  AppError,
  auditActorFromUser,
  hasAuthScope,
  type ActorAccess,
  type ApprovalRequest,
  type ApprovalRequestContext,
  type ApprovalRequestCreator,
  type ApprovalRequestHandler,
  type ApprovalRequestHandlerRegistry,
  type ApprovalRequestStatus,
  type ApprovalRequestStore,
  type AuditRecorder,
  type AuthenticatedUser,
  type ClientInstanceId,
  type JsonObject,
  type RuntimeCallContext
} from "@vivd-catalyst/core";

import type { ApprovalCheckRunner } from "./approval-check-runner";

/** Scopes the approval routes require; the view flags use the same ones. */
const APPROVAL_DECIDE_AUTH_SCOPE = "governance:write";
const APPROVAL_WITHDRAW_AUTH_SCOPE = "conversation:write";

type CallContext = Pick<RuntimeCallContext, "correlationId"> &
  Partial<Omit<RuntimeCallContext, "user" | "clientInstanceId" | "correlationId">>;

export interface ApprovalRequestWorkflowOptions {
  clientInstanceId: ClientInstanceId;
  store: ApprovalRequestStore;
  handlers: ApprovalRequestHandlerRegistry;
  auditRecorder: AuditRecorder;
  checkRunner?: ApprovalCheckRunner;
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
    command: Pick<ApprovalRequest, "kind" | "summary" | "payload" | "origin">
  ): Promise<ApprovalRequest> {
    this.assertClientInstance(user);
    const handler = this.handler(command.kind);
    const payload = handler.validate(command.payload);
    if (!command.summary.trim()) {
      throw new AppError("VALIDATION_FAILED", "Approval request summary is required");
    }
    const checks =
      (await this.options.checkRunner?.run(
        handler,
        { ...command, payload },
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
      requestedBy: { id: user.id, displayLabel: user.displayLabel }
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
    return this.view(user, access, context, request);
  }

  async listRequests(
    user: AuthenticatedUser,
    access: ActorAccess,
    context: CallContext,
    filter: { status?: ApprovalRequestStatus; page?: StorePage } = {}
  ): Promise<ApprovalRequestView[]> {
    const kinds = this.reviewableKinds(user, access);
    if (kinds.length === 0) {
      throw new AppError("FORBIDDEN", "Approval review requires a registered kind's permission");
    }
    const requests = await this.options.store.listApprovalRequests({
      clientInstanceId: this.options.clientInstanceId,
      kinds,
      ...filter
    });
    return Promise.all(requests.map((request) => this.view(user, access, context, request)));
  }

  async pendingCount(
    user: AuthenticatedUser,
    access: ActorAccess
  ): Promise<{ count: number; canReview: boolean }> {
    const kinds = this.reviewableKinds(user, access);
    if (kinds.length === 0) return { count: 0, canReview: false };
    return {
      canReview: true,
      count: await this.options.store.countPendingApprovalRequests({
        clientInstanceId: this.options.clientInstanceId,
        kinds
      })
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
    access.require(handler.requiredPermission);
    const comment = command.comment?.trim();
    if (command.decision === "request_changes" && !comment) {
      throw new AppError("VALIDATION_FAILED", "Requesting changes requires a comment");
    }
    const updated = await this.options.store.transitionPendingApprovalRequest({
      clientInstanceId: this.options.clientInstanceId,
      requestId: request.id,
      resolve: async (pending) => {
        const decision = {
          approved: command.decision === "approve",
          decidedBy: user.id,
          decidedByLabel: user.displayLabel,
          decidedAt: new Date().toISOString(),
          ...(comment ? { comment } : {})
        };
        if (command.decision !== "approve") {
          await this.assertNotApplied(pending, context);
          return {
            status: command.decision === "reject" ? "rejected" : "changes_requested",
            decision
          };
        }
        const payload = handler.validate(pending.payload);
        const handlerContext = this.handlerContext(pending, context);
        if (await handler.isStale(payload, handlerContext)) {
          return { status: "superseded", decision };
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
    const updated = await this.options.store.transitionPendingApprovalRequest({
      clientInstanceId: this.options.clientInstanceId,
      requestId,
      resolve: async (pending) => {
        await this.assertNotApplied(pending, context);
        return {
          status: "withdrawn",
          decision: {
            approved: false,
            decidedBy: user.id,
            decidedByLabel: user.displayLabel,
            decidedAt: new Date().toISOString()
          }
        };
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
    access.require(handler.requiredPermission);
    const revert = handler.revert?.bind(handler);
    if (!revert)
      throw new AppError("CONFLICT", "This approval request kind does not support revert");
    const updated = await this.options.store.transitionApprovedApprovalRequest({
      clientInstanceId: this.options.clientInstanceId,
      requestId,
      resolve: async (approved) => {
        await revert(approved, user, this.handlerContext(approved, context));
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
   * Apply may have committed before recording the approval failed. Such a request must not end
   * as rejected or withdrawn while its change is live; approving it again records the outcome.
   */
  private async assertNotApplied(pending: ApprovalRequest, context: CallContext): Promise<void> {
    const handler = this.options.handlers.get(pending.kind);
    if (await handler?.isApplied?.(pending.payload, this.handlerContext(pending, context))) {
      throw new AppError(
        "CONFLICT",
        "This request's change is already applied; approve it to record the outcome"
      );
    }
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
      (request.requestedBy.id !== user.id &&
        (!handler || !access.authorize(handler.requiredPermission).allowed))
    ) {
      throw new AppError("NOT_FOUND", "Approval request was not found");
    }
    return request;
  }

  private async view(
    user: AuthenticatedUser,
    access: ActorAccess,
    context: CallContext,
    request: ApprovalRequest
  ): Promise<ApprovalRequestView> {
    const handler = this.handler(request.kind);
    const canDecideWithToken = hasAuthScope(user, APPROVAL_DECIDE_AUTH_SCOPE);
    return {
      ...request,
      preview: await handler.preview(
        handler.validate(request.payload),
        this.handlerContext(request, context)
      ),
      // A flag is true only if the route would also accept the caller's token scopes.
      canRevert:
        request.status === "approved" &&
        Boolean(handler.revert) &&
        canDecideWithToken &&
        access.authorize(handler.requiredPermission).allowed,
      canDecide:
        request.status === "pending" &&
        canDecideWithToken &&
        access.authorize(handler.requiredPermission).allowed,
      canWithdraw:
        request.status === "pending" &&
        request.requestedBy.id === user.id &&
        hasAuthScope(user, APPROVAL_WITHDRAW_AUTH_SCOPE)
    };
  }

  private reviewableKinds(user: AuthenticatedUser, access: ActorAccess): string[] {
    this.assertClientInstance(user);
    const kinds = [...this.options.handlers.values()]
      .filter((handler) => access.authorize(handler.requiredPermission).allowed)
      .map((handler) => handler.kind);
    return kinds;
  }

  private handler(kind: string): ApprovalRequestHandler {
    const handler = this.options.handlers.get(kind);
    if (!handler) throw new AppError("NOT_FOUND", "Approval request kind was not found");
    return handler;
  }

  private handlerContext(request: ApprovalRequest, context: CallContext): ApprovalRequestContext {
    return {
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
