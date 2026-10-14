import { AppError } from "./errors";

export type OperationDenial =
  | {
      kind: "forbidden";
      /**
       * The right the caller lacks. Missing where no right opens the call: `user_only` of an
       * operation that names no single right.
       */
      action?: string;
      /**
       * `holder_not_administrable`: the caller may not write a grant row for this holder,
       * whatever right it holds. A service principal writes none, and a service principal's
       * rows are written by who administers service principals. `user_only`: the operation is
       * one a person calls (`auth: "user"`), and the caller is a service principal, whatever
       * right it holds.
       */
      reason:
        | "no_grant"
        | "denied"
        | "unknown_action"
        | "holder_inactive"
        | "holder_not_administrable"
        | "user_only"
        | "outside_key_scope";
      /**
       * What the refusal says, where a rule refused that no right a caller can be granted
       * opens. Without it the refusal names the missing right.
       */
      message?: string;
      /**
       * Set where the caller holds the right and the service principal that bounds a test run
       * of a Workflow draft does not: the refusal names that principal.
       */
      boundBy?: { id: string; label: string };
    }
  | {
      kind: "policy";
      operation: string;
      /**
       * `approval_unavailable`: the policy asks for another person's approval and the call
       * cannot be held for one, as no call of a service principal can. Without a reason the
       * policy refuses the call itself.
       */
      reason?: "approval_unavailable";
      /**
       * The guardrail whose `require_approval` asked for the approval, where one did, with
       * its reason where it gave one.
       */
      guardrail?: { id: string; label: string; reason?: string };
    }
  | { kind: "guardrail"; guardrailId: string; message?: string }
  | { kind: "declined"; by: string; comment?: string };

/** The error a refused call answers with: `403` and a code that names what refused it. */
export function operationDenialError(denial: OperationDenial): AppError {
  switch (denial.kind) {
    case "forbidden":
      return new AppError("FORBIDDEN", denial.message ?? forbiddenMessage(denial), {
        ...(denial.action === undefined ? {} : { action: denial.action }),
        reason: denial.reason,
        ...(denial.boundBy ? { boundBy: denial.boundBy } : {})
      });
    case "policy":
      return denial.reason === "approval_unavailable"
        ? new AppError(
            "POLICY_DENIED",
            denial.guardrail
              ? `The guardrail '${denial.guardrail.label}' asks for another person's approval of '${denial.operation}'${denial.guardrail.reason ? `: ${asSentence(denial.guardrail.reason)}` : "."} The call cannot wait for one. In a Workflow, put an approval step before the step that calls it.`
              : `The instance's policy asks for another person's approval of '${denial.operation}', and this call cannot wait for one. In a Workflow, put an approval step before the step that calls it.`,
            {
              operation: denial.operation,
              reason: denial.reason,
              ...(denial.guardrail ? { guardrailId: denial.guardrail.id } : {})
            }
          )
        : new AppError(
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

/** A reason as the end of a sentence: with its own full stop, or one added. */
function asSentence(reason: string): string {
  return /[.!?]$/u.test(reason) ? reason : `${reason}.`;
}

function forbiddenMessage(denial: Extract<OperationDenial, { kind: "forbidden" }>): string {
  if (denial.action === undefined) return "The call is not allowed";
  if (denial.boundBy)
    return `The principal '${denial.boundBy.label}' does not hold '${denial.action}'; publishing would fail at this step`;
  return denial.reason === "outside_key_scope"
    ? `The API key of this call does not cover '${denial.action}' here. Its owner holds the right; issue a key whose scopes name it`
    : `Missing the right '${denial.action}'`;
}
