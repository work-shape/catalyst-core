import {
  MAIL_RECIPIENT_DOMAINS_ANY,
  MAIL_SEND_REFUSAL_REASONS,
  MAIL_SENDER_USE_ACTION,
  type PlatformAction
} from "@work-shape/catalyst-asset-schemas";
import { isAppError } from "./errors";

/**
 * The rights of a mail sender. `use` sends as it, on one sender: the `admin` role holds it,
 * a member only by a grant, a Workflow's account (AP-10) only on the sender `system`. A grant
 * is written on one named sender and never at instance scope, so a later Connection sender is
 * not reached by a grant given for `system`. The kind registers, with the sender `system`,
 * only while `infrastructure.mail.outbound.enabled` is true (MAIL-1). Spec:
 * events-workflows-and-guardrails.md, Sending e-mail, Rights.
 */
export const MAIL_SENDER_ACTIONS = {
  use: MAIL_SENDER_USE_ACTION
} as const satisfies Record<string, PlatformAction>;

// Frozen by MAIL-0: no operation, sender or template is registered by these.
export {
  MAIL_ADDRESS_MAX_LENGTH,
  MAIL_ATTACHMENTS_MAX_BYTES,
  MAIL_ATTACHMENTS_MAX_FILES,
  MAIL_AUDIT_MAX_DOMAINS,
  MAIL_BODY_MAX_BYTES,
  MAIL_OUTBOUND_DEFAULT_LIMITS,
  MAIL_OUTBOUND_FOOTER_MAX_LENGTH,
  MAIL_RECIPIENT_DOMAIN_PATTERN,
  MAIL_RECIPIENT_DOMAINS_ANY,
  MAIL_RECIPIENT_ID_PATTERN,
  MAIL_SEND_ERROR_CODES,
  MAIL_SEND_MAX_ADDRESSES,
  MAIL_SEND_OPERATION,
  MAIL_SEND_REFUSAL_REASONS,
  MAIL_SENDER_CONNECTION_PREFIX,
  MAIL_SENDER_NAME_MAX_LENGTH,
  MAIL_SENDER_RESOURCE_KIND,
  MAIL_SENDER_SYSTEM,
  MAIL_SENDER_SYSTEM_ICON,
  MAIL_SENDER_USE_ACTION,
  MAIL_SUBJECT_MAX_LENGTH,
  MAIL_WORKFLOW_MESSAGE_TEMPLATE,
  mailAddressSchema,
  mailBodySchema,
  mailCopyRecipientListSchema,
  mailPreviewRecipientSchema,
  mailRecipientDomainSchema,
  mailRecipientListSchema,
  mailRecipientSchema,
  mailReplyToSchema,
  mailSendContract,
  mailSenderIdSchema,
  mailSenderNameSchema,
  mailSendInputSchema,
  mailSendOutputSchema,
  mailSendPreviewSchema,
  mailSendRefusalDetailsSchema,
  mailSendSimulatedOutputSchema,
  mailSubjectSchema,
  workflowMailSenderFactSchema,
  workflowMessageMailParamsSchema,
  WORKFLOW_STEP_SOURCE_KINDS,
  type MailPreviewRecipient,
  type MailSendRecipient,
  type MailSendRecipientList,
  type MailSendErrorCode,
  type MailSenderId,
  type MailSendInput,
  type MailSendInputFields,
  type MailSendOutput,
  type MailSendPreview,
  type MailSendRefusalDetails,
  type MailSendSimulatedOutput,
  type WorkflowMailSenderFact,
  type WorkflowMessageMailParams,
  type WorkflowStepSourceKind
} from "@work-shape/catalyst-asset-schemas";

// MAIL-1: the rule of recipients and the failures of a call, as every surface reads them.

/**
 * The failure of a call whose connection to the provider was never made. Nothing left, so the
 * call changed nothing and the step's attempts make it again.
 */
export const MAIL_SEND_UNSENT_REASON = "mail_provider_unreachable";

/**
 * The failure of a call whose request left and whose answer was lost (a timeout, a 5xx). The
 * provider takes no idempotency key, so the mail may or may not have gone out, and the call is
 * never made again.
 */
export const MAIL_SEND_INTERRUPTED_REASON = "operation_interrupted";

/** Every reason a call of `mail.send` fails for, which a Workflow step takes as its code. */
export const MAIL_SEND_FAILURE_REASONS = [
  ...MAIL_SEND_REFUSAL_REASONS,
  MAIL_SEND_UNSENT_REASON,
  MAIL_SEND_INTERRUPTED_REASON
] as const;
export type MailSendFailureReason = (typeof MAIL_SEND_FAILURE_REASONS)[number];

/** The domain of an address, lowercase: what the recipient rule and the audit read of it. */
export function mailDomainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/**
 * Whether `recipientDomains` admits an address of the domain. A listed domain matches exactly,
 * `*.example.de` its subdomains and not the domain itself, and `*` every domain. An empty list
 * admits none: then only the people of the instance are mailed.
 */
export function mailDomainAllowed(domain: string, recipientDomains: readonly string[]): boolean {
  const name = domain.toLowerCase();
  return recipientDomains.some((listed) => {
    if (listed === MAIL_RECIPIENT_DOMAINS_ANY) return true;
    if (listed.startsWith("*.")) return name.endsWith(listed.slice(1));
    return name === listed;
  });
}

/** The reason a failed call of `mail.send` names in its details, where it names one. */
export function mailSendReasonOf(error: unknown): MailSendFailureReason | undefined {
  if (!isAppError(error)) return undefined;
  const { details } = error;
  if (typeof details !== "object" || details === null || !("reason" in details)) return undefined;
  const { reason } = details;
  return MAIL_SEND_FAILURE_REASONS.find((known) => known === reason);
}
