import { appendApprovalDecision } from "../postgres-conversation-operations";
import * as approvalRequestOperations from "../postgres-approval-request-operations";
import { type ApprovalRequestStore, type ApprovalRequest } from "@vivd-catalyst/core";
import type { ApprovalsStore } from "@vivd-catalyst/core";
import type { PostgresConnection } from "../postgres-database";
export function createPostgresApprovalsStore(db: PostgresConnection): ApprovalsStore {
  return {
    async appendApprovalDecision(request: ApprovalRequest): Promise<void> {
      await db.transaction((tx) => appendApprovalDecision(tx, request));
    },
    createApprovalRequest(input: Parameters<ApprovalRequestStore["createApprovalRequest"]>[0]) {
      return approvalRequestOperations.createApprovalRequest(db, input);
    },
    getApprovalRequest(input: Parameters<ApprovalRequestStore["getApprovalRequest"]>[0]) {
      return approvalRequestOperations.getApprovalRequest(db, input);
    },
    listApprovalRequests(input: Parameters<ApprovalRequestStore["listApprovalRequests"]>[0]) {
      return approvalRequestOperations.listApprovalRequests(db, input);
    },
    countPendingApprovalRequests(
      input: Parameters<ApprovalRequestStore["countPendingApprovalRequests"]>[0]
    ) {
      return approvalRequestOperations.countPendingApprovalRequests(db, input);
    },
    countOwnApprovalRequests(
      input: Parameters<ApprovalRequestStore["countOwnApprovalRequests"]>[0]
    ) {
      return approvalRequestOperations.countOwnApprovalRequests(db, input);
    },
    transitionPendingApprovalRequest(
      input: Parameters<ApprovalRequestStore["transitionPendingApprovalRequest"]>[0]
    ) {
      return approvalRequestOperations.transitionPendingApprovalRequest(db, input);
    },
    transitionApprovedApprovalRequest(
      input: Parameters<ApprovalRequestStore["transitionApprovedApprovalRequest"]>[0]
    ) {
      return approvalRequestOperations.transitionApprovedApprovalRequest(db, input);
    }
  };
}
