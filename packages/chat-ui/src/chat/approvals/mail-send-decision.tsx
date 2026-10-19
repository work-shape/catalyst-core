import {
  MAIL_SEND_OPERATION,
  mailSendSimulatedOutputSchema,
  type MailPreviewRecipient,
  type MailSendPreview
} from "@work-shape/catalyst-core";
import { Chip, FoldedText, KeyValue, KeyValueList } from "@work-shape/catalyst-ui";
import { useTranslation, type TranslationKey } from "../../shared/i18n";

// MAIL-2: an agent's `mail.send` waits for its person, and the card shows the mail as it will
// go out: the sender, the recipients by name or address, the subject and the rendered body as
// text. The server rendered it (the operation's own simulation); the card draws nothing of its
// own. MAIL-3a draws it in the frame (`MailPreview`).

/** The mail a waiting `mail.send` sends, or nothing for any other call. */
export function mailSendDecisionPreview(decision: {
  operationId: string;
  simulation?: unknown;
}): MailSendPreview | undefined {
  if (decision.operationId !== MAIL_SEND_OPERATION) return undefined;
  return mailSendSimulatedOutputSchema.safeParse(decision.simulation).data?.preview;
}

/** The mail as the card shows it: who sends it to whom, the subject and the body. */
export function MailSendDecisionView({ mail }: { mail: MailSendPreview }) {
  const { locale, t } = useTranslation();
  const recipients = (label: TranslationKey, field: string, list: MailPreviewRecipient[]) =>
    list.length === 0 ? null : (
      <KeyValue label={t(label)} data-field={field}>
        <span className="flex min-w-0 flex-wrap gap-1">
          {list.map((recipient, index) => (
            <Chip key={`${index}:${recipient.label}`} size="sm">
              {recipient.label}
            </Chip>
          ))}
        </span>
      </KeyValue>
    );
  return (
    <div className="grid min-w-0 gap-1" data-testid="mail-send-preview">
      <KeyValueList>
        <KeyValue label={t("toolDecisionMailFrom")} data-field="mail-from">
          <span className="wrap-anywhere">
            {mail.from.name} &lt;{mail.from.address}&gt;
          </span>
        </KeyValue>
        {recipients("toolDecisionMailTo", "mail-to", mail.to)}
        {recipients("toolDecisionMailCc", "mail-cc", mail.cc)}
        {recipients("toolDecisionMailBcc", "mail-bcc", mail.bcc)}
        <KeyValue label={t("toolDecisionMailSubject")} data-field="mail-subject">
          <span className="wrap-anywhere">{mail.subject}</span>
        </KeyValue>
        <KeyValue label={t("toolDecisionMailBody")} data-field="mail-body">
          <FoldedText>{mail.text}</FoldedText>
        </KeyValue>
      </KeyValueList>
      {mail.skipped > 0 ? (
        <p className="text-caption text-muted-foreground" data-field="mail-skipped">
          {t(mail.skipped === 1 ? "toolDecisionMailSkippedOne" : "toolDecisionMailSkipped", {
            count: new Intl.NumberFormat(locale).format(mail.skipped)
          })}
        </p>
      ) : null}
    </div>
  );
}
