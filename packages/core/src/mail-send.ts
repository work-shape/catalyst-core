import { MAIL_SENDER_USE_ACTION, type PlatformAction } from "@work-shape/catalyst-asset-schemas";

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
