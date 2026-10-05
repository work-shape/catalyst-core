import type { FastifyInstance } from "fastify";
import { apiOperations, listApprovalRequestsQuerySchema } from "@vivd-catalyst/api-contract";
import { AppError, requireAuthScope } from "@vivd-catalyst/core";
import {
  APPROVAL_DECIDE_AUTH_SCOPE,
  APPROVAL_WITHDRAW_AUTH_SCOPE,
  ApprovalRequestWorkflow
} from "../approval-request-workflow";
import { authenticateRequest, parseBody } from "../request-context";
import type { ChatServerOptions } from "../types";

export function registerApprovalRequestRoutes(
  app: FastifyInstance,
  options: ChatServerOptions
): void {
  if (!options.approvalRequests) return;
  const workflow = new ApprovalRequestWorkflow({
    ...options.approvalRequests,
    clientInstanceId: options.clientInstanceId,
    auditRecorder: options.auditRecorder
  });

  // A card in a thread reads and withdraws with chat scopes; the review queue and every
  // decision are governance actions, which chat session tokens cannot carry.
  app.get(apiOperations.getApprovalRequest.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "conversation:read");
    return workflow.getRequest(user, context, requestId(request.params));
  });
  app.get(apiOperations.listApprovalRequests.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "governance:read");
    return workflow.listRequests(
      user,
      context,
      parseBody(listApprovalRequestsQuerySchema, request.query)
    );
  });
  app.get(apiOperations.countPendingApprovalRequests.path, async (request) => {
    const { user } = await authenticateRequest(options, request);
    requireAuthScope(user, "conversation:read");
    return workflow.pendingCount(user);
  });
  app.post(apiOperations.decideApprovalRequest.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, APPROVAL_DECIDE_AUTH_SCOPE);
    const body = parseBody(apiOperations.decideApprovalRequest.requestSchema, request.body);
    return workflow.decideRequest(user, context, { ...body, requestId: requestId(request.params) });
  });
  app.post(apiOperations.withdrawApprovalRequest.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, APPROVAL_WITHDRAW_AUTH_SCOPE);
    return workflow.withdrawRequest(user, context, requestId(request.params));
  });
  app.post(apiOperations.revertApprovalRequest.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, APPROVAL_DECIDE_AUTH_SCOPE);
    return workflow.revertRequest(user, context, requestId(request.params));
  });
}

function requestId(params: unknown): string {
  const id = (params as { requestId?: string }).requestId;
  if (!id) throw new AppError("BAD_REQUEST", "Missing approval request id");
  return id;
}
