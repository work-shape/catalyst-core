import { listQuerySchema } from "../shared";
import {
  approvalRequestSchema,
  approvalRequestViewSchema,
  decideApprovalRequestSchema,
  listApprovalRequestsQuerySchema,
  pendingApprovalRequestCountSchema
} from "../approval-requests";
import { defineOperation, json, page } from "./define-operation";

export const approvalRequestOperations = {
  getApprovalRequest: defineOperation({
    id: "getApprovalRequest",
    method: "GET",
    path: "/api/approval-requests/:requestId",
    summary: "Read one approval request",
    tag: "Approval Requests",
    auth: "user",
    scope: "conversation:read",
    requires: [],
    effect: "reading",
    response: json(approvalRequestViewSchema),
    errors: ["NOT_FOUND"],
    rateClass: "read"
  }),
  listApprovalRequests: defineOperation({
    id: "listApprovalRequests",
    method: "GET",
    path: "/api/approval-requests",
    summary: "List approval requests in the review queue",
    tag: "Approval Requests",
    auth: "user",
    scope: "governance:read",
    requires: [],
    effect: "reading",
    query: listApprovalRequestsQuerySchema.extend(listQuerySchema.shape),
    response: page(approvalRequestViewSchema, ["createdAt", "id"], true),
    errors: [],
    rateClass: "read"
  }),
  countPendingApprovalRequests: defineOperation({
    id: "countPendingApprovalRequests",
    method: "GET",
    path: "/api/approval-requests/pending-count",
    summary: "Count the approval requests waiting for the caller",
    tag: "Approval Requests",
    auth: "user",
    scope: "conversation:read",
    requires: [],
    effect: "reading",
    response: json(pendingApprovalRequestCountSchema),
    errors: [],
    rateClass: "read"
  }),
  decideApprovalRequest: defineOperation({
    id: "decideApprovalRequest",
    method: "POST",
    path: "/api/approval-requests/:requestId/decide",
    summary: "Approve or reject an approval request",
    tag: "Approval Requests",
    auth: "user",
    scope: "governance:write",
    requires: [],
    effect: "changing",
    body: decideApprovalRequestSchema,
    response: json(approvalRequestSchema),
    errors: ["NOT_FOUND", "CONFLICT"],
    rateClass: "write"
  }),
  withdrawApprovalRequest: defineOperation({
    id: "withdrawApprovalRequest",
    method: "POST",
    path: "/api/approval-requests/:requestId/withdraw",
    summary: "Withdraw an approval request the caller created",
    tag: "Approval Requests",
    auth: "user",
    scope: "conversation:write",
    requires: [],
    effect: "changing",
    response: json(approvalRequestSchema),
    errors: ["NOT_FOUND", "CONFLICT"],
    rateClass: "write"
  }),
  revertApprovalRequest: defineOperation({
    id: "revertApprovalRequest",
    method: "POST",
    path: "/api/approval-requests/:requestId/revert",
    summary: "Revert an applied approval request",
    tag: "Approval Requests",
    auth: "user",
    scope: "governance:write",
    requires: [],
    effect: "changing",
    response: json(approvalRequestSchema),
    errors: ["NOT_FOUND", "CONFLICT"],
    rateClass: "write"
  })
} as const;
