import { z } from "zod";

const jsonObjectSchema = z.record(z.string(), z.unknown());

export const approvalRequestStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "changes_requested",
  "superseded",
  "withdrawn"
]);

export const approvalCheckResultSchema = z.object({
  id: z.string(),
  status: z.enum(["passed", "warned", "blocked"]),
  message: z.string()
});

export const approvalRequestSchema = z.object({
  id: z.string(),
  clientInstanceId: z.string(),
  kind: z.string(),
  summary: z.string(),
  payload: jsonObjectSchema,
  requestedBy: z.object({ id: z.string(), displayLabel: z.string() }),
  origin: z
    .object({
      conversationId: z.string(),
      agentRunId: z.string(),
      toolCallId: z.string(),
      agentName: z.string()
    })
    .optional(),
  status: approvalRequestStatusSchema,
  decision: z
    .object({
      approved: z.boolean(),
      decidedBy: z.string(),
      decidedByLabel: z.string(),
      decidedAt: z.string(),
      reason: z.string().optional(),
      comment: z.string().optional()
    })
    .optional(),
  checks: z.array(approvalCheckResultSchema),
  applyResult: jsonObjectSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

export const approvalRequestViewSchema = approvalRequestSchema.extend({
  preview: jsonObjectSchema,
  canDecide: z.boolean(),
  canWithdraw: z.boolean()
});

export const listApprovalRequestsQuerySchema = z.object({
  status: approvalRequestStatusSchema.optional()
});
export const pendingApprovalRequestCountSchema = z.object({
  count: z.number().int().nonnegative(),
  canReview: z.boolean()
});
export const decideApprovalRequestSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approve"), comment: z.string().optional() }),
  z.object({ decision: z.literal("reject"), comment: z.string().optional() }),
  z.object({ decision: z.literal("request_changes"), comment: z.string().trim().min(1) })
]);

export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;
export type ApprovalRequestView = z.infer<typeof approvalRequestViewSchema>;
export type ApprovalRequestStatus = z.infer<typeof approvalRequestStatusSchema>;
