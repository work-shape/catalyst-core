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

/** What each error code tells a caller, as the reference states it. */
export const API_ERROR_MEANINGS: Record<z.infer<typeof appErrorCodeSchema>, string> = {
  BAD_REQUEST: "The request cannot be read.",
  UNAUTHENTICATED: "No credential was presented, or the credential is not valid.",
  FORBIDDEN: "The caller lacks the scope or the right this operation requires.",
  NOT_FOUND:
    "The resource does not exist, is not visible to the caller, or the instance runs without this operation.",
  CONFLICT: "The request conflicts with the current state of the resource.",
  TIMEOUT: "The instance did not finish the work in time.",
  VALIDATION_FAILED: "Path, query or body do not match the operation's schema.",
  RATE_LIMITED: "The caller sent too many requests of this operation's rate class.",
  INTERNAL: "The instance failed. The message never carries details."
};

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
