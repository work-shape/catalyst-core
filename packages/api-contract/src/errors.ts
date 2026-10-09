import { z } from "zod";

export const appErrorCodeSchema = z.enum([
  "BAD_REQUEST",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "TIMEOUT",
  "VALIDATION_FAILED",
  "RATE_LIMITED",
  "INTERNAL"
]);

export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: appErrorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
    correlationId: z.string().min(1)
  })
});

export type ApiErrorCode = z.infer<typeof appErrorCodeSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
