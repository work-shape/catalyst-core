import type { ReactNode } from "react";
import {
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  KeyValue,
  KeyValueList,
  MailPreview,
  RegistryIcon,
  TemplateText,
  type MailPreviewRecipient,
  type PickerOption,
  type TemplatePart
} from "@work-shape/catalyst-ui";
import { MarkdownArtifact } from "../../chat/markdown/markdown-text";
import { useTranslation } from "../../shared/i18n";
import {
  MAIL_ICON_FALLBACK,
  MAIL_OPERATION,
  fieldRefWords,
  mailAnswerOf,
  mailRunOf,
  mailSentence,
  recipientWords,
  type MailRunRecipient
} from "./mail-step";
import { fieldKey } from "./mapping-rows";
import type { RecipientNames } from "./recipient-names";
import { mailFooter } from "./workflow-canvas-model";
import type {
  WorkflowMailRecipientView,
  WorkflowMailView,
  WorkflowStepRunView,
  WorkflowTextPartView
} from "./workflow-views";
import { useRecipientNames, useWorkflowsHost } from "./workflows-host";

// A Send email step in the step's panel (workflow-canvas 9.2, 9.3; MAIL-3a): "What it does"
// shows the mail the definition writes in the instance's frame, "This run" the mail as the run
// sent it. The body of a run is shown only to a reader who is given the step run's input,
// which the instance answers only with `workflow.read_run_data`.

/** How many lines of the body "What it does" shows before "Show all". */
const BODY_FOLD_LINES = 12;

type Translation = ReturnType<typeof useTranslation>;

/** A text of the definition as the library's parts, and the fields it names as options. */
export function templateOf(parts: readonly WorkflowTextPartView[] | undefined): {
  value: TemplatePart[];
  options: PickerOption[];
} {
  const options = new Map<string, string>();
  const value = (parts ?? []).map((part): TemplatePart => {
    if (typeof part === "string") return part;
    const key = fieldKey(part.ref);
    options.set(key, part.ref.field);
    return { option: key };
  });
  return { value, options: [...options].map(([key, label]) => ({ value: key, label })) };
}

function TextOf({ parts }: { parts: readonly WorkflowTextPartView[] | undefined }) {
  const { value, options } = templateOf(parts);
  return <TemplateText value={value} options={options} />;
}

/** The recipients of the definition as the preview names them. */
function previewRecipients(
  list: readonly WorkflowMailRecipientView[] | undefined,
  names: RecipientNames,
  translation: Translation
): MailPreviewRecipient[] {
  return (list ?? []).map((recipient) =>
    recipient.kind === "picked"
      ? { label: fieldRefWords(recipient.ref, translation), picked: true }
      : { label: recipientWords(recipient, names, translation) }
  );
}

/** The instance's name and logo, which frame the mail as the template frames it. */
export function useMailBrand(): { name: string; mark?: ReactNode } | undefined {
  const brand = useWorkflowsHost()?.brand;
  if (brand === undefined) return undefined;
  const logo = brand.logoUrl;
  return {
    name: brand.name,
    ...(logo === undefined
      ? {}
      : {
          mark: (
            <>
              <img
                src={logo}
                alt=""
                className={brand.logoUrlDark === undefined ? undefined : "dark:hidden"}
              />
              {brand.logoUrlDark === undefined ? null : (
                <img src={brand.logoUrlDark} alt="" className="hidden dark:block" />
              )}
            </>
          )
        })
  };
}

/** Who the mail is from, with the sender's icon. */
export function mailFrom(mail: WorkflowMailView, translation: Translation) {
  return {
    name: mail.senderName ?? mail.senderTitle ?? translation.t("workflows.mail.systemSender"),
    ...(mail.senderAddress === undefined ? {} : { address: mail.senderAddress }),
    icon: <RegistryIcon name={mail.icon} fallback={MAIL_ICON_FALLBACK} />
  };
}

/** Where the mail may go: the instance's `recipientDomains` in words. */
function outsideWords(domains: readonly string[] | undefined, { t, locale }: Translation) {
  if (domains === undefined) return undefined;
  if (domains.length === 0) return t("workflows.mail.onlyInstance");
  if (domains.includes("*")) return t("workflows.mail.maySendAnywhere");
  return t("workflows.mail.maySendTo", {
    domains: new Intl.ListFormat(locale, { type: "conjunction" }).format(domains)
  });
}

/** "What it does" of a Send email step: the mail as the definition writes it. */
export function MailStepDescription({
  stepId,
  mail,
  draft
}: {
  stepId: string;
  mail: WorkflowMailView;
  /** The panel is of a draft: its mail is simulated in a test run. */
  draft: boolean;
}) {
  const translation = useTranslation();
  const { t, locale } = translation;
  const names = useRecipientNames();
  const brand = useMailBrand();
  const replyTo =
    mail.replyTo ??
    (mail.replyToUser === undefined
      ? undefined
      : (names.people.get(mail.replyToUser) ?? t("workflows.mail.unnamed")));
  const outside = outsideWords(mail.recipientDomains, translation);
  const ids = [...(mail.to ?? []), ...(mail.cc ?? []), ...(mail.bcc ?? [])].flatMap((recipient) =>
    recipient.kind === "user" || recipient.kind === "workspace" ? [recipient.id] : []
  );
  const language =
    mail.locale === "en"
      ? t("workflows.mail.languageEn")
      : mail.locale === "de"
        ? t("workflows.mail.languageDe")
        : mail.locale;
  return (
    <>
      <p data-step-sentence="">{mailSentence(mail, names, { t, locale })}</p>
      <MailPreview
        label={t("workflows.mail.preview")}
        from={mailFrom(mail, translation)}
        to={previewRecipients(mail.to, names, translation)}
        cc={previewRecipients(mail.cc, names, translation)}
        bcc={previewRecipients(mail.bcc, names, translation)}
        {...(mail.subject === undefined ? {} : { subject: <TextOf parts={mail.subject} /> })}
        {...(brand === undefined ? {} : { brand })}
        foldLines={BODY_FOLD_LINES}
      >
        {mail.body === undefined ? null : (
          <p className="text-body whitespace-pre-wrap">
            <TextOf parts={mail.body} />
          </p>
        )}
      </MailPreview>
      {replyTo === undefined && outside === undefined && language === undefined ? null : (
        <KeyValueList>
          {replyTo === undefined ? null : (
            <KeyValue label={t("workflows.mail.replyTo")}>{replyTo}</KeyValue>
          )}
          {language === undefined ? null : (
            <KeyValue label={t("workflows.mail.language")}>{language}</KeyValue>
          )}
          {outside === undefined ? null : (
            <KeyValue label={t("workflows.mail.outside")}>{outside}</KeyValue>
          )}
        </KeyValueList>
      )}
      {draft ? (
        <p className="text-caption text-muted-foreground" data-mail-draft-note="">
          {t("workflows.mail.draftNote")}
        </p>
      ) : null}
      <Disclosure>
        <DisclosureTrigger>{t("workflows.technicalDetails")}</DisclosureTrigger>
        <DisclosureContent>
          <KeyValueList>
            <KeyValue label={t("workflows.mail.operation")}>
              <code className="text-code">{MAIL_OPERATION}</code>
            </KeyValue>
            {ids.length === 0 ? null : (
              <KeyValue label={t("workflows.mail.recipientIds")}>
                <code className="text-code break-all">{ids.join(", ")}</code>
              </KeyValue>
            )}
            <KeyValue label={t("workflows.mail.stepId")}>
              <code className="text-code">{stepId}</code>
            </KeyValue>
          </KeyValueList>
        </DisclosureContent>
      </Disclosure>
    </>
  );
}

function runRecipientWords(
  list: readonly MailRunRecipient[],
  names: RecipientNames,
  translation: Translation
): MailPreviewRecipient[] {
  return list.map((recipient) => ({ label: recipientWords(recipient, names, translation) }));
}

/**
 * "This run" of a Send email step: whether it sent, sent as a test or was simulated, and the
 * mail as it went out for a reader who is given the step run's input.
 */
export function MailStepRun({
  mail,
  stepRun
}: {
  mail: WorkflowMailView;
  stepRun: WorkflowStepRunView;
}) {
  const translation = useTranslation();
  const { t } = translation;
  const names = useRecipientNames();
  const brand = useMailBrand();
  const answer = mailAnswerOf(stepRun.output);
  const run = mailRunOf(stepRun.input);
  const outcome =
    stepRun.status === "done" && stepRun.failure === undefined
      ? mailFooter(stepRun, translation)
      : undefined;
  const ended = stepRun.finishedAt !== undefined;
  if (run === undefined) {
    return (
      <section data-mail-run="" className="grid min-w-0 gap-2">
        {outcome === undefined ? null : <p data-mail-outcome="">{outcome}</p>}
        {ended && stepRun.output !== undefined ? (
          <p className="text-caption text-muted-foreground" data-mail-no-content="">
            {t("workflows.mail.noContent")}
          </p>
        ) : null}
      </section>
    );
  }
  const preview = answer?.kind === "simulated" ? answer.preview : undefined;
  const intended = {
    to: runRecipientWords(run.to, names, translation),
    cc: runRecipientWords([...run.cc, ...run.bcc], names, translation)
  };
  // What the instance resolved names whom it sent to; the input names them as the step gave them.
  const listed = (labels: readonly string[] | undefined, fallback: MailPreviewRecipient[]) =>
    labels === undefined ? fallback : labels.map((label) => ({ label }));
  const test = answer?.kind === "sent" && answer.test;
  const subject = preview?.subject ?? run.subject;
  return (
    <section data-mail-run="" className="grid min-w-0 gap-2">
      {outcome === undefined ? null : <p data-mail-outcome="">{outcome}</p>}
      <MailPreview
        label={t("workflows.mail.preview")}
        simulated={stepRun.target === "dry_run"}
        {...(test ? { test: intended } : {})}
        from={
          preview?.from === undefined
            ? mailFrom(mail, translation)
            : { ...preview.from, icon: mailFrom(mail, translation).icon }
        }
        to={test ? [] : listed(preview?.to, intended.to)}
        cc={test ? [] : listed(preview?.cc, runRecipientWords(run.cc, names, translation))}
        bcc={test ? [] : listed(preview?.bcc, runRecipientWords(run.bcc, names, translation))}
        {...(subject === undefined ? {} : { subject })}
        {...(preview?.html === undefined ? {} : { html: preview.html })}
        {...(brand === undefined || preview?.html !== undefined ? {} : { brand })}
      >
        {run.body === undefined ? null : <MarkdownArtifact>{run.body}</MarkdownArtifact>}
      </MailPreview>
      {run.shortened ? (
        <p className="text-caption text-muted-foreground" data-mail-shortened="">
          {t("workflows.mail.shortened")}
        </p>
      ) : null}
    </section>
  );
}
