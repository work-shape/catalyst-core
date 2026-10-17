import { z } from "zod";

// Node timers cannot represent a longer delay; refuse it rather than silently waiting 1 ms.
const MAXIMUM_TIMER_MS = 2_147_483_647;
const timer = z.coerce.number().int().min(0).max(MAXIMUM_TIMER_MS);

export const accountingRestOptionsSchema = z.object({
  latencyMs: timer.default(0),
  rateLimitAfter: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  rateWindowMs: timer.min(1).default(60_000),
  unavailable: z
    .union([z.boolean(), z.enum(["true", "false"]).transform((value) => value === "true")])
    .default(false),
  unavailableClientId: z.coerce.number().int().positive().optional(),
  scaleDivisor: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1)
});

export type AccountingRestOptions = z.input<typeof accountingRestOptionsSchema>;
