import { z } from "zod";
import { listQuerySchema } from "../shared";
import { auditActivitySchema, auditEventSchema, usageSummarySchema } from "../governance";
import { defineOperation, json, page } from "./define-operation";

export const governanceOperations = {
  listAuditEvents: defineOperation({
    id: "listAuditEvents",
    method: "GET",
    path: "/api/audit-events",
    summary: "List the latest audit events",
    tag: "Governance",
    auth: "user",
    scope: "governance:read",
    requires: ["audit.view"],
    effect: "reading",
    query: listQuerySchema,
    response: page(auditEventSchema, ["createdAt", "id"], true),
    errors: [],
    rateClass: "read"
  }),
  listAuditActivities: defineOperation({
    id: "listAuditActivities",
    method: "GET",
    path: "/api/audit-activities",
    summary: "List the latest audit activities",
    tag: "Governance",
    auth: "user",
    scope: "governance:read",
    requires: ["audit.view"],
    effect: "reading",
    // The latest activities only: not a paged list, so it takes no limit and no cursor.
    response: json(z.object({ items: z.array(auditActivitySchema) })),
    errors: [],
    rateClass: "read"
  }),
  getUsageSummary: defineOperation({
    id: "getUsageSummary",
    method: "GET",
    path: "/api/superadmin/usage",
    summary: "Read model usage and budget of the instance",
    tag: "Governance",
    auth: "user",
    scope: "governance:read",
    requires: ["usage.view"],
    effect: "reading",
    response: json(usageSummarySchema),
    errors: [],
    rateClass: "read"
  })
} as const;
