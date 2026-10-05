import { z } from "zod";
import { usageSafeguardsSchema } from "./configuration";
import { auditActorSchema } from "./identity";

export const auditEventSchema = z.object({
  id: z.string(),
  clientInstanceId: z.string(),
  type: z.string(),
  status: z.string(),
  actor: auditActorSchema.optional(),
  subject: z.string().optional(),
  reason: z.string().optional(),
  correlationId: z.string(),
  createdAt: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional()
});

export const auditActivityActorSchema = z.object({
  kind: z.enum(["user", "assistant", "service", "system"]),
  label: z.string(),
  onBehalfOf: z.string().optional(),
  roles: z.array(z.string()).optional()
});

export const auditActivityTargetSchema = z.object({
  kind: z.string(),
  id: z.string(),
  label: z.string().optional()
});

export const auditActivitySchema = z.object({
  correlationId: z.string(),
  at: z.string(),
  label: z.string(),
  tier: z.enum(["governance", "workflow", "runtime", "telemetry"]),
  outcome: z.enum(["success", "failed", "denied", "warning"]),
  actor: auditActivityActorSchema,
  target: auditActivityTargetSchema.optional(),
  reason: z.string().optional(),
  eventCount: z.number().int().nonnegative(),
  repeatCount: z.number().int().nonnegative(),
  evidence: z.array(auditEventSchema)
});

export const modelUsageVolumeEventSchema = z.object({
  id: z.string(),
  clientInstanceId: z.string(),
  conversationId: z.string(),
  agentRunId: z.string(),
  agentName: z.string(),
  providerId: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  cachedInputTokens: z.number().optional(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  webSearchCallCount: z.number().int().nonnegative(),
  fastMode: z.boolean(),
  source: z.enum(["provider_reported", "not_reported", "estimated"]),
  correlationId: z.string(),
  createdAt: z.string()
});

export const modelUsageVolumeWindowSummarySchema = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
  modelCallCount: z.number(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  webSearchCallCount: z.number().int().nonnegative()
});

export const modelUsageBillableCostSchema = z.object({
  status: z.enum(["settled", "incomplete", "unpriced"]),
  currency: z.string().optional(),
  uncachedInputBillableCostMicros: z.number().int().nonnegative().optional(),
  cachedInputBillableCostMicros: z.number().int().nonnegative().optional(),
  outputBillableCostMicros: z.number().int().nonnegative().optional(),
  webSearchBillableCostMicros: z.number().int().nonnegative().optional(),
  billableCostMicros: z.number().int().nonnegative().optional(),
  complete: z.boolean(),
  webSearchCostVisible: z.boolean()
});

export const modelUsageBillableCostSummarySchema = modelUsageBillableCostSchema.extend({
  settledModelCallCount: z.number().int().nonnegative(),
  incompleteModelCallCount: z.number().int().nonnegative(),
  settledWebSearchCallCount: z.number().int().nonnegative(),
  incompleteWebSearchCallCount: z.number().int().nonnegative()
});

export const modelUsageEventSchema = modelUsageVolumeEventSchema.extend({
  cost: modelUsageBillableCostSchema
});

export const modelUsageWindowSummarySchema = modelUsageVolumeWindowSummarySchema.extend({
  cost: modelUsageBillableCostSummarySchema
});

export const modelUsageDailyBucketSchema = modelUsageWindowSummarySchema.extend({
  date: z.string()
});

export const modelUsageMonthlyBucketSchema = modelUsageWindowSummarySchema.extend({
  month: z.string()
});

export const usageSpendBudgetSchema = z.object({
  currency: z.string().optional(),
  dailyLimitMicros: z.number().int().nonnegative().optional(),
  monthlyLimitMicros: z.number().int().nonnegative().optional()
});

export const usageSummarySchema = z.object({
  generatedAt: z.string(),
  spendBudget: usageSpendBudgetSchema,
  safeguards: usageSafeguardsSchema,
  today: modelUsageWindowSummarySchema,
  currentMonth: modelUsageWindowSummarySchema,
  allTime: modelUsageWindowSummarySchema,
  dailyUsage: z.array(modelUsageDailyBucketSchema),
  monthlyUsage: z.array(modelUsageMonthlyBucketSchema),
  recentEvents: z.array(modelUsageEventSchema)
});

export type AuditEvent = z.infer<typeof auditEventSchema>;
export type AuditActivity = z.infer<typeof auditActivitySchema>;
export type AuditActivityActor = z.infer<typeof auditActivityActorSchema>;
export type AuditActivityTarget = z.infer<typeof auditActivityTargetSchema>;
export type ModelUsageVolumeEvent = z.infer<typeof modelUsageVolumeEventSchema>;
export type ModelUsageBillableCost = z.infer<typeof modelUsageBillableCostSchema>;
export type ModelUsageBillableCostSummary = z.infer<typeof modelUsageBillableCostSummarySchema>;
export type ModelUsageEvent = z.infer<typeof modelUsageEventSchema>;
export type ModelUsageDailyBucket = z.infer<typeof modelUsageDailyBucketSchema>;
export type ModelUsageMonthlyBucket = z.infer<typeof modelUsageMonthlyBucketSchema>;
export type UsageSummary = z.infer<typeof usageSummarySchema>;
