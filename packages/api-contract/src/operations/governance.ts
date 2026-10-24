import { z } from "zod";
import { listQuerySchema } from "../shared";
import { auditActivitySchema, auditEventSchema, usageSummarySchema } from "../governance";
import {
  setUsageSpendLimitRequestSchema,
  usageLimitsSchema,
  usageSpendLimitChangeSchema
} from "../usage-limits";
import { defineOperation, defineRegisteredOperation, json, page } from "./define-operation";

export const governanceOperations = {
  "audit_events.list": defineOperation({
    id: "audit_events.list",
    method: "GET",
    path: "/api/v1/instance/audit-events",
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
  "audit_activities.list": defineOperation({
    id: "audit_activities.list",
    method: "GET",
    path: "/api/v1/instance/audit-activities",
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
  "usage.get_summary": defineOperation({
    id: "usage.get_summary",
    method: "GET",
    path: "/api/v1/instance/usage",
    summary: "Read model usage and budget of the instance",
    tag: "Governance",
    auth: "user",
    scope: "governance:read",
    requires: ["usage.view"],
    effect: "reading",
    response: json(usageSummarySchema),
    errors: [],
    rateClass: "read"
  }),
  // Spend limits at three levels (LU-2). The screen, the CLI and an MCP client share these two,
  // and each change is an audit event with its old and its new value.
  "usage.limits.get": defineRegisteredOperation({
    id: "usage.limits.get",
    method: "GET",
    path: "/api/v1/instance/usage/limits",
    summary:
      "Read the spend limits of the instance, of shared workspaces and of users, with those at or near a limit",
    tag: "Governance",
    auth: "user",
    scope: "governance:read",
    requires: ["limits.manage"],
    effect: "reading",
    response: json(usageLimitsSchema),
    errors: [],
    rateClass: "read"
  }),
  "usage.limits.set": defineRegisteredOperation({
    id: "usage.limits.set",
    method: "PUT",
    path: "/api/v1/instance/usage/limits",
    summary:
      "Set or remove the spend limit per day and month of the instance, of shared workspaces or of users. An instance limit stays at or below the release config's.",
    tag: "Governance",
    auth: "user",
    scope: "governance:write",
    requires: ["limits.manage"],
    effect: "changing",
    body: setUsageSpendLimitRequestSchema,
    response: json(usageSpendLimitChangeSchema),
    errors: ["NOT_FOUND"],
    rateClass: "write"
  })
} as const;
