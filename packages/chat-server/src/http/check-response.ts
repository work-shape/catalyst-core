import type { Operation } from "@vivd-catalyst/api-contract";
import { AppError } from "@vivd-catalyst/core";
import type { z } from "zod";
import type { ResolvedChatServerOptions } from "../types";

/**
 * A response outside its contract is always logged. Only a development instance refuses it:
 * the handler has already committed its work by now, and one stored value outside an enum
 * would otherwise fail a whole list for the people using an operated instance.
 */
export function checkResponse(
  options: Pick<ResolvedChatServerOptions, "config" | "logger">,
  operation: Operation,
  schema: z.ZodType,
  result: unknown
): void {
  const validated = schema.safeParse(result);
  if (validated.success) {
    return;
  }
  // Paths and codes only: the values are the payload the schema refused.
  options.logger.error(
    {
      operationId: operation.id,
      issues: validated.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code
      }))
    },
    "Operation response does not match its schema"
  );
  if (options.config.clientInstance.environment === "development") {
    throw new AppError("INTERNAL", `Operation '${operation.id}' returned an invalid response`);
  }
}
