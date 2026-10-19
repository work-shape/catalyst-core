import {
  AppError,
  MAIL_SEND_ERROR_CODES,
  MAIL_SEND_OPERATION,
  mailDomainAllowed,
  mailDomainOf,
  mailRecipientListSchema,
  mailReplyToSchema,
  mailSenderNameSchema,
  mailSubjectSchema,
  type ClientInstanceId,
  type PlatformStores,
  type WorkflowManifest,
  type WorkflowStep
} from "@work-shape/catalyst-core";
import type { z } from "zod";
import { activePersonOf, mailRecipientItemsOf } from "./mail-send-operation";

// The recipient rule of `mail.send` asked of a Workflow's definition, at a save and a publish:
// what a step writes as a literal is decided before any run. A referenced value is decided by
// the run, which asks the same rule. A step naming `mail.send` where the instance has no
// outbound mail is refused as the run would fail it.

export interface MailSendStepRule {
  clientInstanceId: ClientInstanceId;
  stores: Pick<PlatformStores, "users">;
  /** Whether `mail.send` exists on the instance: outbound mail is on. */
  registered: boolean;
  /** `infrastructure.mail.outbound.recipientDomains`. */
  recipientDomains: readonly string[];
}

/** The literal value of one field of a step's mapping, where the field is a literal. */
function literalOf(step: Extract<WorkflowStep, { type: "operation" }>, field: string): unknown {
  const mapped = step.input[field];
  return mapped && "value" in mapped ? mapped.value : undefined;
}

/** The addresses a literal recipient list names as addresses, never people or workspaces. */
function addressesOf(value: z.infer<typeof mailRecipientListSchema>): string[] {
  return mailRecipientItemsOf(value).flatMap((item) =>
    item.kind === "address" ? [item.email] : []
  );
}

function refused(step: string, reason: string, message: string, domain?: string): AppError {
  return new AppError("VALIDATION_FAILED", message, {
    reason,
    step,
    ...(domain === undefined ? {} : { domain })
  });
}

/**
 * The first refusal of the definition's `mail.send` steps: `operation_not_found` where the
 * instance has no outbound mail, `input_invalid` for a literal field the operation refuses, and
 * `recipient_not_allowed` naming the domain of a literal address that is outside the rule and
 * no person's of the instance. Nothing where every step may be saved.
 */
export async function mailSendStepRefusal(
  manifest: Pick<WorkflowManifest, "steps">,
  rule: MailSendStepRule
): Promise<AppError | undefined> {
  for (const step of operationSteps(manifest.steps)) {
    if (step.operation !== MAIL_SEND_OPERATION) continue;
    if (!rule.registered) {
      return refused(
        step.id,
        "operation_not_found",
        `The step '${step.name}' sends an e-mail, and this instance sends none: outbound mail is off`
      );
    }
    const fields: [string, z.ZodType][] = [
      ["subject", mailSubjectSchema],
      ["senderName", mailSenderNameSchema],
      ["replyTo", mailReplyToSchema],
      ["to", mailRecipientListSchema],
      ["cc", mailRecipientListSchema],
      ["bcc", mailRecipientListSchema]
    ];
    for (const [field, schema] of fields) {
      const value = literalOf(step, field);
      if (value !== undefined && !schema.safeParse(value).success) {
        return refused(
          step.id,
          "input_invalid",
          `The ${field} of the step '${step.name}' is not one the e-mail may have`
        );
      }
    }
    for (const field of ["to", "cc", "bcc", "replyTo"]) {
      const value = literalOf(step, field);
      if (value === undefined) continue;
      const list = mailRecipientListSchema.safeParse(
        typeof value === "object" && value !== null && !Array.isArray(value) ? [value] : value
      );
      if (!list.success) continue;
      for (const address of addressesOf(list.data)) {
        const domain = mailDomainOf(address);
        if (mailDomainAllowed(domain, rule.recipientDomains)) continue;
        if (await activePersonOf(rule.stores, rule.clientInstanceId, address)) continue;
        return refused(
          step.id,
          MAIL_SEND_ERROR_CODES.recipientNotAllowed,
          `The step '${step.name}' mails an address in '${domain}', which this instance does not send to`,
          domain
        );
      }
    }
  }
  return undefined;
}

function operationSteps(
  steps: readonly WorkflowStep[]
): Extract<WorkflowStep, { type: "operation" }>[] {
  return steps.flatMap((step) => {
    if (step.type === "operation") return [step];
    if (step.type === "loop") return operationSteps(step.steps);
    return [];
  });
}
