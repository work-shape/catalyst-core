import { AppError } from "./errors";

export type OperationDenial =
  | {
      kind: "forbidden";
      action: string;
      /**
       * `holder_not_administrable`: the caller may not write a grant row for this holder,
       * whatever right it holds. A service principal writes none, and a service principal's
       * rows are written by who administers service principals.
       */
      reason:
        "no_grant" | "denied" | "unknown_action" | "holder_inactive" | "holder_not_administrable";
      /**
       * What the refusal says, where a rule refused that no right a caller can be granted
       * opens. Without it the refusal names the missing right.
       */
      message?: string;
    }
  | { kind: "policy"; operation: string }
  | { kind: "guardrail"; guardrailId: string; message?: string }
  | { kind: "declined"; by: string; comment?: string };

/** The error a refused call answers with: `403` and a code that names what refused it. */
export function operationDenialError(denial: OperationDenial): AppError {
  switch (denial.kind) {
    case "forbidden":
      return new AppError("FORBIDDEN", denial.message ?? `Missing the right '${denial.action}'`, {
        action: denial.action,
        reason: denial.reason
      });
    case "policy":
      return new AppError(
        "POLICY_DENIED",
        `The instance's policy does not allow '${denial.operation}' from here`,
        { operation: denial.operation }
      );
    case "guardrail":
      return new AppError("GUARDRAIL_BLOCKED", denial.message ?? "A guardrail blocked the call", {
        guardrailId: denial.guardrailId
      });
    case "declined":
      return new AppError("DECLINED", "The call was declined", {
        by: denial.by,
        ...(denial.comment === undefined ? {} : { comment: denial.comment })
      });
  }
}
