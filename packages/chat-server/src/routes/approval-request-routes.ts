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
  route(apiOperations["approval_requests.get"], ({ user, access, context, params }) =>
    workflow.getRequest(user, access, context, requestId(params))
  );
  route(apiOperations["approval_requests.list"], ({ user, access, context, query, paging }) =>
    workflow.listRequests(user, access, context, {
      status: query.status,
      scope: query.scope,
      page: paging
    })
  );
  // A person's own requests are theirs to follow, so the list needs no governance scope.
  route(apiOperations["approval_requests.list_mine"], ({ user, access, context, paging }) =>
    workflow.listOwnRequests(user, access, context, { page: paging })
  );
  route(apiOperations["approval_requests.count_pending"], ({ user, access }) =>
    workflow.pendingCount(user, access)
  );
  route(apiOperations["approval_requests.decide"], ({ user, access, context, params, body }) =>
    workflow.decideRequest(user, access, context, { ...body, requestId: requestId(params) })
  );
  route(apiOperations["approval_requests.withdraw"], ({ user, access, context, params }) =>
    workflow.withdrawRequest(user, access, context, requestId(params))
  );
  route(apiOperations["approval_requests.revert"], ({ user, access, context, params }) =>
    workflow.revertRequest(user, access, context, requestId(params))
  );
}

function requestId(params: { requestId: string }): string {
  return requirePathParam(params.requestId, "Missing approval request id");
}
