import { z } from "zod";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import {
  AppError,
  asUserId,
  getSubjectUserId,
  isAuthenticatedServicePrincipal,
  type AuthenticatedUser
} from "@work-shape/catalyst-core";
import { visibleApproverNames } from "../approvals/visible-approvers";
import { ApprovalRequestWorkflow } from "../approvals/approval-request-service";
import type { Route } from "../http/route";
import { requirePathParam } from "./request-context";
import type { ResolvedChatServerOptions } from "../types";
import {
  alwaysAllowRefusal,
  recordOperationSettingChanged,
  setOwnOperationSetting
} from "../users/operation-settings-service";
import { operationSettingsDeps } from "./operation-setting-routes";

export function registerApprovalRequestRoutes(
  route: Route,
  options: ResolvedChatServerOptions
): void {
  if (!options.approvalRequests) return;
  const workflow = new ApprovalRequestWorkflow({
    ...options.approvalRequests,
    clientInstanceId: options.clientInstanceId,
    auditRecorder: options.auditRecorder,
    approverNames: (user, handler, request) =>
      visibleApproverNames(options, user, handler, request),
    // A held publish's review leads with a sentence in the language of who opens it (PUBQ-1).
    readerLocale: async (userId, requested) =>
      (
        await options.stores.users.getUser({
          clientInstanceId: options.clientInstanceId,
          userId: asUserId(userId)
        })
      )?.locale ??
      requested ??
      options.config.localization.defaultLocale
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
  const settings = operationSettingsDeps(options);

  /**
   * "Always allow" with allowing a confirmation in the Inbox (OP-6): only on the person's own
   * confirmation of a call whose card offered it, while the admin still permits it. Checked
   * before the decision, so a refusal decides nothing.
   */
  const alwaysAllowedOperation = async (
    user: AuthenticatedUser,
    id: string,
    decision: string
  ): Promise<string> => {
    const refused = (message = "Always allow is not available for this request") =>
      new AppError("FORBIDDEN", message, { reason: "always_allow_not_permitted" });
    if (decision !== "approve") {
      throw new AppError("VALIDATION_FAILED", "Always allow comes only with allowing the call");
    }
    if (isAuthenticatedServicePrincipal(user) || user.delegatedActor !== undefined) {
      throw refused();
    }
    const request = await options.approvalRequests?.store.getApprovalRequest({
      clientInstanceId: options.clientInstanceId,
      requestId: id
    });
    const runId =
      request?.kind === "operation_call" &&
      request.status === "pending" &&
      request.addresseeUserId === getSubjectUserId(user)
        ? z.object({ runId: z.string() }).safeParse(request.payload).data?.runId
        : undefined;
    const call = runId
      ? await options.stores.operationRuns.get({
          clientInstanceId: options.clientInstanceId,
          id: runId
        })
      : undefined;
    const definition = call
      ? await settings.registry.resolve(call.operation).catch(() => undefined)
      : undefined;
    if (!call || call.status !== "pending_confirmation" || !call.offersAlwaysAllow || !definition) {
      throw refused();
    }
    const refusal = await alwaysAllowRefusal(settings, definition);
    if (refusal) throw refused(refusal);
    return call.operation;
  };

  route(
    apiOperations["approval_requests.decide"],
    async ({ user, access, context, params, body }) => {
      const id = requestId(params);
      const operation =
        body.decision === "approve" && body.alwaysAllow
          ? await alwaysAllowedOperation(user, id, body.decision)
          : undefined;
      const view = await workflow.decideRequest(user, access, context, {
        decision: body.decision,
        ...(body.comment === undefined ? {} : { comment: body.comment }),
        requestId: id
      });
      if (operation && view.status === "approved") {
        const { changed } = await setOwnOperationSetting(settings, {
          actor: user,
          operation,
          value: "always_allow"
        });
        if (changed) {
          await recordOperationSettingChanged(options.auditRecorder, {
            actor: user,
            correlationId: context.correlationId,
            operation,
            value: "always_allow"
          });
        }
      }
      return view;
    }
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
