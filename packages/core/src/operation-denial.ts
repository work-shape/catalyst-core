import { OPERATION_DENIAL_REASONS } from "@work-shape/catalyst-asset-schemas";
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
      reason: (typeof OPERATION_DENIAL_REASONS)[number];
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
       * cannot be held for one, as no call of a service principal can. `approval_stale`: the
       * call waited for an approval, and what it is about moved since, or a newer call about
       * the same replaced it. `workflow_deleted`: the call is a step of a run of a published
       * Workflow whose `confirm` its publish approved, and the Workflow was deleted since.
       * `confirmation_required`: the call needs a person's confirmation or approval and a
       * subagent made it, which never waits for a decision (CR-1); its parent makes it instead.
       * Without a reason the policy refuses the call itself.
       */
      reason?:
        | "approval_unavailable"
        | "approval_stale"
        | "workflow_deleted"
        | "confirmation_required"
        | "confirmation_unattended";
      /**
       * The guardrail whose `require_approval` asked for the approval, where one did, with
       * its reason where it gave one.
       */
      guardrail?: { id: string; label: string; reason?: string };
    }
  | {
      kind: "guardrail";
      guardrailId: string;
      message?: string;
      guardrailTitle?: string;
      guardrailReason?: string;
    }
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
      if (denial.reason === "approval_stale") {
        return new AppError("POLICY_DENIED", approvalStaleMessage(denial.operation), {
          operation: denial.operation,
          reason: denial.reason
        });
      }
      if (denial.reason === "confirmation_required") {
        return new AppError("POLICY_DENIED", confirmationRequiredMessage(denial.operation), {
          operation: denial.operation,
          reason: denial.reason
        });
      }
      if (denial.reason === "workflow_deleted") {
        return new AppError(
          "POLICY_DENIED",
          `The Workflow of this run was deleted, so its publish no longer confirms '${denial.operation}'`,
          { operation: denial.operation, reason: denial.reason }
        );
      }
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
        guardrailId: denial.guardrailId,
        ...(denial.guardrailTitle === undefined ? {} : { guardrailTitle: denial.guardrailTitle }),
        ...(denial.guardrailReason === undefined ? {} : { guardrailReason: denial.guardrailReason })
      });
    case "declined":
      return new AppError("DECLINED", "The call was declined", {
        by: denial.by,
        ...(denial.comment === undefined ? {} : { comment: denial.comment })
      });
  }
}

/**
 * What a subagent reads for a call that needs a person's decision: it did not run, and the
 * agent that started the subagent can make it, where the person is asked.
 */
export function confirmationRequiredMessage(operation: string): string {
  return `'${operation}' needs the person's confirmation, and a subagent cannot ask for one. Nothing ran. Go on without it, and say in your answer that '${operation}' still has to be called, so the agent that started you can make the call.`;
}

/** Why a call that waited for an approval can no longer be approved. */
function approvalStaleMessage(operation: string): string {
  return `The call of '${operation}' waited for an approval, and what it is about changed since or a newer call replaced it. Make the call again.`;
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
