import { apiOperations } from "@vivd-catalyst/api-contract";
import { ApprovalRequestWorkflow } from "../approval-request-workflow";
import type { Route } from "../http/route";
import { requirePathParam } from "../request-context";
import type { ChatServerOptions } from "../types";

export function registerApprovalRequestRoutes(route: Route, options: ChatServerOptions): void {
  if (!options.approvalRequests) return;
  const workflow = new ApprovalRequestWorkflow({
    ...options.approvalRequests,
    clientInstanceId: options.clientInstanceId,
    auditRecorder: options.auditRecorder
  });

  // A card in a thread reads and withdraws with chat scopes; the review queue and every
  // decision are governance actions, which chat session tokens cannot carry.
  route(apiOperations.getApprovalRequest, ({ user, context, params }) =>
    workflow.getRequest(user, context, requestId(params))
  );
  route(apiOperations.listApprovalRequests, ({ user, context, query, paging }) =>
    workflow.listRequests(user, context, { status: query.status, page: paging })
  );
  route(apiOperations.countPendingApprovalRequests, ({ user }) => workflow.pendingCount(user));
  route(apiOperations.decideApprovalRequest, ({ user, context, params, body }) =>
    workflow.decideRequest(user, context, { ...body, requestId: requestId(params) })
  );
  route(apiOperations.withdrawApprovalRequest, ({ user, context, params }) =>
    workflow.withdrawRequest(user, context, requestId(params))
  );
  route(apiOperations.revertApprovalRequest, ({ user, context, params }) =>
    workflow.revertRequest(user, context, requestId(params))
  );
}

function requestId(params: { requestId: string }): string {
  return requirePathParam(params.requestId, "Missing approval request id");
}
