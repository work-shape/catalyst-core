import { z } from "zod";

export const usageBudgetConfigSchema = z
  .object({
    dailySpendLimit: z.number().positive().optional(),
    monthlySpendLimit: z.number().positive().optional(),
    costSafetyMultiplier: z.number().min(1).default(1)
  })
  .default({ costSafetyMultiplier: 1 });

export const usageSafeguardsConfigSchema = z
  .object({
    modelCallsPerDay: z.number().int().positive().optional(),
    tokensPerDay: z.number().int().positive().optional(),
    tokensPerMonth: z.number().int().positive().optional()
  })
  .default({});

const usageRateCardTokenRatesShape = {
  uncachedInputPricePerMillionTokens: z.number().nonnegative(),
  cachedInputPricePerMillionTokens: z.number().nonnegative(),
  outputPricePerMillionTokens: z.number().nonnegative()
};

export const usageRateCardConfigSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/u)
    .default("USD"),
  models: z
    .array(
      z.object({
        providerId: z.string().min(1),
        model: z.string().min(1),
        ...usageRateCardTokenRatesShape,
        fast: z.object(usageRateCardTokenRatesShape).optional()
      })
    )
    .default([]),
  webSearch: z
    .array(
      z.object({
        providerId: z.string().min(1),
        model: z.string().min(1).optional(),
        pricePerCall: z.number().nonnegative()
      })
    )
    .default([])
});

export const usageCostConfigSchema = z
  .object({
    customer: usageRateCardConfigSchema.optional()
  })
  .default({});
