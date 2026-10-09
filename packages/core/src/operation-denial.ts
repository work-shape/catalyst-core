import { AppError } from "./errors";

export type OperationDenial =
  | {
      kind: "forbidden";
      action: string;
      reason: "no_grant" | "denied" | "unknown_action" | "holder_inactive";
    }
  | { kind: "policy"; operation: string }
  | { kind: "guardrail"; guardrailId: string; message?: string }
  | { kind: "declined"; by: string; comment?: string };

/** The error a refused call answers with: `403` and a code that names what refused it. */
export function operationDenialError(denial: OperationDenial): AppError {
  switch (denial.kind) {
    case "forbidden":
      return new AppError("FORBIDDEN", `Missing the right '${denial.action}'`, {
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
