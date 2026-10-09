import { z } from "zod";
import { auditActivitySchema, auditEventSchema, usageSummarySchema } from "../governance";
import { defineOperation, json } from "./define-operation";

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
    response: json(z.array(auditEventSchema)),
    errors: [],
    rateClass: "read"
  }),
  listAuditActivities: defineOperation({
    id: "listAuditActivities",
    method: "GET",
    path: "/api/audit-activities",
    summary: "List audit events grouped into activities",
    tag: "Governance",
    auth: "user",
    scope: "governance:read",
    requires: ["audit.view"],
    effect: "reading",
    response: json(z.array(auditActivitySchema)),
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
