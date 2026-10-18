import { z } from "zod";

export const usageBudgetConfigSchema = z
  .object({
    dailySpendLimit: z.number().positive().optional(),
    monthlySpendLimit: z.number().positive().optional(),
    costSafetyMultiplier: z.number().min(1).default(1)
  })
  .default({ costSafetyMultiplier: 1 });

/**
 * The safeguards of one person, against a loop that runs away (`UsageSafeguardsConfig`). They
 * are no budget: the spend limits of `usageBudgetConfigSchema` are. A person who reaches one
 * has their next model call refused with `MODEL_USAGE_LIMIT_REACHED` until the day or the
 * month is over.
 *
 * The defaults fit a long working day of a busy person about five times. Measured 2026-10-18
 * (ACCEPT-1c): one person's normal agent use made 91 model calls holding 2.5 million tokens in
 * 35 minutes. Over 8 hours that is about 1,250 calls and 34 million tokens, and over 22 working
 * days 754 million tokens.
 */
const DEFAULT_MODEL_CALLS_PER_DAY = 20_000;
const DEFAULT_TOKENS_PER_DAY = 200_000_000;
const DEFAULT_TOKENS_PER_MONTH = 4_000_000_000;

export const usageSafeguardsConfigSchema = z
  .object({
    modelCallsPerDay: z.number().int().positive().default(DEFAULT_MODEL_CALLS_PER_DAY),
    tokensPerDay: z.number().int().positive().default(DEFAULT_TOKENS_PER_DAY),
    tokensPerMonth: z.number().int().positive().default(DEFAULT_TOKENS_PER_MONTH)
  })
  .prefault({});

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
