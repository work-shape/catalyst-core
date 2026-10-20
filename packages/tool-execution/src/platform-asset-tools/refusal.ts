import { isAppError } from "@work-shape/catalyst-core";
import { z } from "zod";
import { draftConflictDetailsSchema, type PlatformAssetWrite } from "./shapes";

const refusalDetailsSchema = z.object({
  reason: z.string().optional(),
  issues: z
    .array(
      z.object({
        message: z.string(),
        path: z.union([z.string(), z.array(z.union([z.string(), z.number()]))]).optional(),
        code: z.string().optional()
      })
    )
    .optional()
});

/**
 * What a refused save tells its agent, where the refusal is one the agent can act on: the
 * issues of a definition that does not hold, or the conflict of a stale revision. Any other
 * refusal, a missing right among them, is nothing here and stays the error it is.
 */
export function platformAssetWriteRefusal(
  error: unknown
): Extract<PlatformAssetWrite, { saved: false }> | undefined {
  if (!isAppError(error)) return undefined;
  if (error.code === "REVISION_CONFLICT") {
    const draft = draftConflictDetailsSchema.safeParse(error.details);
    return {
      saved: false,
      conflict: "REVISION_CONFLICT",
      message: error.message,
      ...(draft.success ? { details: draft.data } : {})
    };
  }
  if (error.code !== "VALIDATION_FAILED") return undefined;
  const details = refusalDetailsSchema.safeParse(error.details);
  const issues = details.success ? (details.data.issues ?? []) : [];
  const reason = details.success ? details.data.reason : undefined;
  return {
    saved: false,
    issues:
      issues.length > 0
        ? issues.map((issue) => ({
            path: Array.isArray(issue.path) ? issue.path.join(".") : (issue.path ?? ""),
            message: issue.message,
            ...(issue.code === undefined ? {} : { code: issue.code })
          }))
        : [{ path: "", message: error.message, ...(reason === undefined ? {} : { code: reason }) }]
  };
}
