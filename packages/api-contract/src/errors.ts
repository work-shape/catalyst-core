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

/**
 * `details.reason` of the 404 a server answers for a method and path that is no operation of
 * its catalog. An operation the instance runs without answers 404 without it. A caller built
 * from the catalog reads it as: this caller belongs to another release than the server.
 */
export const UNKNOWN_OPERATION_REASON = "unknown_operation";

const unknownOperationSchema = z.object({
  error: z.object({
    code: z.literal("NOT_FOUND"),
    details: z.object({ reason: z.literal(UNKNOWN_OPERATION_REASON) })
  })
});

export function isUnknownOperationResponse(payload: unknown): boolean {
  return unknownOperationSchema.safeParse(payload).success;
}

export type ApiErrorCode = z.infer<typeof appErrorCodeSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
