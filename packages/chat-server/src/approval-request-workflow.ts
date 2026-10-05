import {
  AppError,
  auditActorFromUser,
  hasPermission,
  requirePermission,
  type ApprovalRequest,
  type ApprovalRequestContext,
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

type CallContext = Pick<RuntimeCallContext, "correlationId">;

export interface ApprovalRequestWorkflowOptions {
  clientInstanceId: ClientInstanceId;
  store: ApprovalRequestStore;
  handlers: ApprovalRequestHandlerRegistry;
  auditRecorder: AuditRecorder;
  onDecided?(request: ApprovalRequest): void | Promise<void>;
}

export interface ApprovalRequestView extends ApprovalRequest {
  preview: JsonObject;
  canDecide: boolean;
  canWithdraw: boolean;
}

export class ApprovalRequestWorkflow {
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
    const request = await this.options.store.createApprovalRequest({
      ...command,
      payload,
      clientInstanceId: this.options.clientInstanceId,
      requestedBy: { id: user.id, displayLabel: user.displayLabel }
    });
    await this.record(user, context, "approval_request.created", request);
    return request;
  }

  async getRequest(
    user: AuthenticatedUser,
    context: CallContext,
    requestId: string
  ): Promise<ApprovalRequestView> {
    const request = await this.visibleRequest(user, requestId);
    return this.view(user, context, request);
  }

  async listRequests(
    user: AuthenticatedUser,
    context: CallContext,
    filter: { status?: ApprovalRequestStatus } = {}
  ): Promise<ApprovalRequestView[]> {
    const kinds = this.reviewableKinds(user);
    if (kinds.length === 0) {
      throw new AppError("FORBIDDEN", "Approval review requires a registered kind's permission");
    }
    const requests = await this.options.store.listApprovalRequests({
      clientInstanceId: this.options.clientInstanceId,
      kinds,
      ...filter
    });
    return Promise.all(requests.map((request) => this.view(user, context, request)));
  }

  async pendingCount(user: AuthenticatedUser): Promise<{ count: number; canReview: boolean }> {
    const kinds = this.reviewableKinds(user);
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
    context: CallContext,
    command: {
      requestId: string;
      decision: "approve" | "reject" | "request_changes";
      comment?: string;
    }
  ): Promise<ApprovalRequest> {
    const request = await this.visibleRequest(user, command.requestId);
    const handler = this.handler(request.kind);
    requirePermission(user, handler.requiredPermission);
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
    context: CallContext,
    requestId: string
  ): Promise<ApprovalRequest> {
    const request = await this.visibleRequest(user, requestId);
    if (request.requestedBy.id !== user.id) {
      throw new AppError("FORBIDDEN", "Only the requester can withdraw an approval request");
    }
    const updated = await this.options.store.transitionPendingApprovalRequest({
      clientInstanceId: this.options.clientInstanceId,
      requestId,
      resolve: async () => ({ status: "withdrawn" })
    });
    await this.record(user, context, "approval_request.withdrawn", updated);
    await this.options.onDecided?.(updated);
    return updated;
  }

  private async visibleRequest(
    user: AuthenticatedUser,
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
        (!handler || !hasPermission(user, handler.requiredPermission)))
    ) {
      throw new AppError("NOT_FOUND", "Approval request was not found");
    }
    return request;
  }

  private async view(
    user: AuthenticatedUser,
    context: CallContext,
    request: ApprovalRequest
  ): Promise<ApprovalRequestView> {
    const handler = this.handler(request.kind);
    return {
      ...request,
      preview: await handler.preview(
        handler.validate(request.payload),
        this.handlerContext(request, context)
      ),
      canDecide: request.status === "pending" && hasPermission(user, handler.requiredPermission),
      canWithdraw: request.status === "pending" && request.requestedBy.id === user.id
    };
  }

  private reviewableKinds(user: AuthenticatedUser): string[] {
    this.assertClientInstance(user);
    const kinds = [...this.options.handlers.values()]
      .filter((handler) => hasPermission(user, handler.requiredPermission))
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
      origin: request.origin
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
      metadata: { requestId: request.id, kind: request.kind, status: request.status }
    });
  }
}
