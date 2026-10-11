import { isAppError, type AppError } from "@vivd-catalyst/core";
import { errorIssues } from "./asset-access";

/** Why one item stops the batch. */
export interface ItemRefusal {
  code: "FORBIDDEN" | "CONFLICT" | "NOT_FOUND" | "VALIDATION_FAILED";
  message: string;
  /** The right the caller lacks, for a refusal of rights. */
  action?: string;
  /** What the asset is at, for an item made against another revision. */
  currentRevision?: number | null;
}

/** Which refusal names the batch's error, where its items were refused for different reasons. */
export const REFUSAL_ORDER = ["FORBIDDEN", "NOT_FOUND", "CONFLICT", "VALIDATION_FAILED"] as const;

export function toRefusal(error: AppError): ItemRefusal {
  const code = REFUSAL_ORDER.find((candidate) => candidate === error.code);
  if (!code) {
    throw error;
  }
  return {
    code,
    message: errorIssues(error)
      .map(({ message }) => message)
      .join("; ")
  };
}

/** Runs a rule of a kind that refuses by throwing, and answers its refusal. */
export function refusalOf(rule: () => void): ItemRefusal | undefined {
  try {
    rule();
    return undefined;
  } catch (error) {
    if (isAppError(error)) {
      return toRefusal(error);
    }
    throw error;
  }
}
