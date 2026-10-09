import { z } from "zod";
import { operationRunSchema, operationRunStatusSchema } from "../operation-runs";
import { listQuerySchema, timestampSchema } from "../shared";
import { defineOperation, json, page } from "./define-operation";

export const operationRunOperations = {
  "operations.get_run": defineOperation({
    id: "operations.get_run",
    method: "GET",
    path: "/api/v1/operations/runs/:runId",
    summary: "Read one Operation Run: your own, or any with the right to view the audit log",
    tag: "Operations",
    auth: "principal",
    scope: "governance:read",
    // A caller reads its own run without a right. Another caller's run takes the right
    // `audit.view`, which the operation checks itself.
    requires: [],
    effect: "reading",
    response: json(operationRunSchema),
    errors: ["NOT_FOUND"],
    rateClass: "read"
  }),
  "operations.list_runs": defineOperation({
    id: "operations.list_runs",
    method: "GET",
    path: "/api/v1/operations/runs",
    summary: "List the Operation Runs of the instance, newest first",
    tag: "Operations",
    auth: "principal",
    scope: "governance:read",
    requires: ["audit.view"],
    effect: "reading",
    query: listQuerySchema.extend({
      operation: z.string().min(1).optional(),
      status: operationRunStatusSchema.optional(),
      /** The id of the user or service principal that called. */
      actor: z.string().min(1).optional(),
      origin: z.enum(["agent", "user", "cli", "mcp", "app", "workflow", "schedule"]).optional(),
      workspaceId: z.string().min(1).optional(),
      /** Runs created at or after this moment. */
      since: timestampSchema.optional()
    }),
    response: page(operationRunSchema, ["createdAt", "id"], true),
    errors: [],
    rateClass: "read"
  })
} as const;
