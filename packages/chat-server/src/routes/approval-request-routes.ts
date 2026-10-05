import type { FastifyInstance } from "fastify";
import { apiOperations, listApprovalRequestsQuerySchema } from "@vivd-catalyst/api-contract";
import { AppError } from "@vivd-catalyst/core";
import { ApprovalRequestWorkflow } from "../approval-request-workflow";
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

  app.get(apiOperations.getApprovalRequest.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    return workflow.getRequest(user, context, requestId(request.params));
  });
  app.get(apiOperations.listApprovalRequests.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    return workflow.listRequests(
      user,
      context,
      parseBody(listApprovalRequestsQuerySchema, request.query)
    );
  });
  app.get(apiOperations.countPendingApprovalRequests.path, async (request) => {
    const { user } = await authenticateRequest(options, request);
    return workflow.pendingCount(user);
  });
  app.post(apiOperations.decideApprovalRequest.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    const body = parseBody(apiOperations.decideApprovalRequest.requestSchema, request.body);
    return workflow.decideRequest(user, context, { ...body, requestId: requestId(request.params) });
  });
  app.post(apiOperations.withdrawApprovalRequest.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    return workflow.withdrawRequest(user, context, requestId(request.params));
  });
}

function requestId(params: unknown): string {
  const id = (params as { requestId?: string }).requestId;
  if (!id) throw new AppError("BAD_REQUEST", "Missing approval request id");
  return id;
}
