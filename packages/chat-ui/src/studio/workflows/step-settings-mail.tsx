import { useState, type ReactNode } from "react";
import {
  Banner,
  Disclosure,
  DisclosureContent,
  DisclosureTrigger,
  Field,
  Input,
  MailPreview,
  RecipientField,
  SegmentedControl,
  SegmentedControlItem,
  Select,
  TemplateTextField,
  normalizeTemplateParts,
  type MailPreviewRecipient,
  type RecipientDirectoryEntry,
  type RecipientItem,
  type TemplatePart
} from "@work-shape/catalyst-ui";
import { MarkdownArtifact } from "../../chat/markdown/markdown-text";
import { useTranslation } from "../../shared/i18n";
import {
  MAIL_SYSTEM_SENDER,
  addressOutside,
  mailRecipientsOf,
  mailTextOf,
  mailViewOf,
  previewValue,
  sampleText,
  valueAt,
  type FieldRefResolver
} from "./mail-step";
import { earlierFields, fieldKey, fieldOfKey } from "./mapping-rows";
import { mailFrom, useMailBrand } from "./step-mail";
import { fieldWords, isRecord, type KindProps } from "./step-settings-parts";
import { useWorkflowRun, useWorkflowRuns } from "./workflow-data";
import type { WorkflowStepRunView } from "./workflow-views";
import { useRecipientNames } from "./workflows-host";

// The Settings of a Send email step (workflow-canvas 9.4, MAIL-3b): who it is from, whom it
// goes to, its subject and its text, each written into the step's `input` as `mail.send`
// takes it. A text with a value of an earlier result is saved in the `text` form; a list of
// recipients is either written out or the one field of an earlier result that holds it, since
// the mapping has no form that joins the two.

type RecipientsField = "to" | "cc" | "bcc";
type TextField = "subject" | "body";
type Sample = (option: string) => unknown;

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The recipients of the field as the step's input takes them; nothing for none. */
export function recipientsInput(items: readonly RecipientItem[]): unknown {
  const picked = items.find((item) => item.kind === "picked");
  if (picked !== undefined) {
    const ref = fieldOfKey(picked.value);
    return ref === undefined ? undefined : { ref };
  }
  if (items.length === 0) return undefined;
  return {
    value: items.map((item) =>
      item.kind === "person"
        ? { user: item.value }
        : item.kind === "workspace"
          ? { workspace: item.value }
          : { address: item.value }
    )
  };
}

/** A text as the step's input takes it: the `text` form where it holds a value of a step. */
export function textInput(parts: readonly TemplatePart[]): unknown {
  const joined = normalizeTemplateParts(parts);
  if (joined.length === 0) return undefined;
  if (joined.every((part) => typeof part === "string")) return { value: joined.join("") };
  return {
    text: joined.flatMap((part): (string | { ref: { step: string; path: string } })[] => {
      if (typeof part === "string") return [part];
      const ref = fieldOfKey(part.option);
      return ref === undefined ? [] : [{ ref }];
    })
  };
}

/** A text of the step's input as the field's parts; nothing for a form the field cannot show. */
export function textParts(value: unknown, resolve: FieldRefResolver): TemplatePart[] | undefined {
  if (value === undefined) return [];
  return mailTextOf(value, resolve)?.map((part) =>
    typeof part === "string" ? part : { option: fieldKey(part.ref) }
  );
}

/** The values a run gave the fields of earlier steps, by their option. */
export function sampleOf(stepRuns: readonly WorkflowStepRunView[] | undefined): Sample {
  const outputs = new Map<string, unknown>();
  for (const stepRun of stepRuns ?? []) {
    if (stepRun.iteration !== undefined || outputs.has(stepRun.stepId)) continue;
    outputs.set(stepRun.stepId, previewValue(stepRun.output));
  }
  return (option) => {
    const ref = fieldOfKey(option);
    if (ref === undefined || !outputs.has(ref.step)) return undefined;
    return valueAt(outputs.get(ref.step), ref.path);
  };
}

/** The Settings of a step that sends an e-mail. */
export function MailSettings({
  step,
  stepId,
  editing,
  issue,
  under,
  set,
  missing,
  left,
  changeWithAgent
}: KindProps & { changeWithAgent: ReactNode }) {
  const translation = useTranslation();
  const { t } = translation;
  const names = useRecipientNames();
  const [view, setView] = useState<"write" | "preview">("write");
  const input = isRecord(step.input) ? step.input : {};
  const fact = editing.stepFacts?.[stepId];
  const fields = earlierFields(editing.manifest, stepId, editing.stepFacts, fieldWords(t));
  const labels = new Map(
    fields.flatMap((group) => group.options.map((option) => [option.value, option.label]))
  );
  const labelOf = (option: string) =>
    labels.get(option) ?? fieldOfKey(option)?.path.split(".").at(-1) ?? option;
  const resolve: FieldRefResolver = (ref) => ({
    from: { from: "step", name: "" },
    field: labelOf(fieldKey(ref))
  });
  const mail = mailViewOf(input, fact, resolve);
  const domains = mail.recipientDomains;
  const setInput = (field: string, value: unknown) => {
    const { [field]: _before, ...rest } = input;
    set({ input: value === undefined ? rest : { ...rest, [field]: value } });
  };
  const literal = (field: string) =>
    isRecord(input[field]) && "value" in input[field] ? input[field].value : undefined;

  // Everyone the reader may name, and whoever the step names whom the reader may not.
  const directory: RecipientDirectoryEntry[] = [
    ...[...names.people].map(([id, label]) => ({ kind: "person" as const, value: id, label })),
    ...[...names.workspaces].map(([id, label]) => ({
      kind: "workspace" as const,
      value: id,
      label
    }))
  ];

  const recipients = (field: RecipientsField) => {
    const read = mailRecipientsOf(input[field], resolve);
    if (read === undefined) return undefined;
    return read.map((recipient): RecipientItem => {
      switch (recipient.kind) {
        case "user":
          return {
            kind: "person",
            value: recipient.id,
            label: names.people.get(recipient.id) ?? t("workflows.mail.unnamed")
          };
        case "workspace":
          return {
            kind: "workspace",
            value: recipient.id,
            label: names.workspaces.get(recipient.id) ?? t("workflows.mail.unnamed")
          };
        case "address":
          return {
            kind: "address",
            value: recipient.address,
            label: recipient.address,
            ...(addressOutside(recipient.address, domains)
              ? {
                  invalid: t("workflows.mail.outsideAddress", {
                    domain: recipient.address.slice(recipient.address.lastIndexOf("@") + 1)
                  })
                }
              : {})
          };
        case "picked": {
          const option = fieldKey(recipient.ref);
          return { kind: "picked", value: option, label: labelOf(option) };
        }
      }
    });
  };

  const agentOnly = (label: string) => (
    <div className="grid gap-2">
      <p className="text-label">{label}</p>
      <p className="text-body text-muted-foreground">{t("workflows.settings.getsAgentOnly")}</p>
      {changeWithAgent}
    </div>
  );

  const recipientField = (field: RecipientsField, label: string, required: boolean) => {
    const value = recipients(field);
    if (value === undefined) return agentOnly(label);
    return (
      <div className="grid gap-2" data-mail-field={field}>
        <RecipientField
          label={label}
          value={value}
          directory={directory}
          fields={fields}
          pickedAlone
          required={required}
          optional={!required}
          error={
            issue(`input.${field}`) ??
            (required
              ? missing(`input.${field}`, value.length === 0, t("workflows.mail.toMissing"))
              : undefined)
          }
          onBlur={left(`input.${field}`)}
          onChange={(next) => setInput(field, recipientsInput(next))}
        />
        {under(`input.${field}`)}
      </div>
    );
  };

  const subject = textParts(input.subject, resolve);
  const body = textParts(input.body, resolve);
  const textMissing = (field: TextField, parts: readonly TemplatePart[], sentence: string) =>
    issue(`input.${field}`) ??
    missing(`input.${field}`, normalizeTemplateParts(parts).length === 0, sentence);

  const senderName = text(literal("senderName"));
  const replyTo = literal("replyTo");
  const replyAddress =
    typeof replyTo === "string" ? replyTo : isRecord(replyTo) ? text(replyTo.address) : "";
  const replyUser = isRecord(replyTo) && typeof replyTo.user === "string";
  const locale = text(literal("locale"));
  const senderTitle = mail.senderTitle ?? t("workflows.mail.systemSender");

  return (
    <div className="grid min-w-0 gap-5" data-mail-settings="">
      {fact !== undefined && fact.available === false ? (
        <Banner tone="warning" layout="inline" data-mail-unavailable="">
          {t("workflows.mail.unavailable")}
        </Banner>
      ) : null}
      <div className="grid gap-3" data-mail-field="from">
        <Field label={t("workflows.mail.from")} error={issue("input.sender")}>
          <Select
            value={mail.sender}
            onChange={(event) => setInput("sender", { value: event.target.value })}
          >
            {/* The instance's own sender is the only one until a Connection sends (MAIL-M365S). */}
            <option value={MAIL_SYSTEM_SENDER}>
              {mail.senderAddress === undefined
                ? senderTitle
                : `${senderTitle} <${mail.senderAddress}>`}
            </option>
          </Select>
        </Field>
        <Field
          label={t("workflows.mail.senderName")}
          optional
          hint={
            mail.senderAddress === undefined
              ? t("workflows.mail.senderNameHintNoAddress")
              : t("workflows.mail.senderNameHint", { address: mail.senderAddress })
          }
          error={issue("input.senderName")}
        >
          <Input
            value={senderName}
            placeholder={senderTitle}
            onChange={(event) =>
              setInput(
                "senderName",
                event.target.value === "" ? undefined : { value: event.target.value }
              )
            }
            onBlur={left("input.senderName")}
          />
        </Field>
        {under("input.sender")}
      </div>
      {recipientField("to", t("workflows.mail.to"), true)}
      {recipientField("cc", t("workflows.mail.cc"), false)}
      {recipientField("bcc", t("workflows.mail.bcc"), false)}
      {subject === undefined ? (
        agentOnly(t("workflows.mail.subject"))
      ) : (
        <div className="grid gap-2" data-mail-field="subject">
          <TemplateTextField
            label={t("workflows.mail.subject")}
            value={subject}
            options={fields}
            required
            error={textMissing("subject", subject, t("workflows.mail.subjectMissing"))}
            onBlur={left("input.subject")}
            onChange={(next) => setInput("subject", textInput(next))}
          />
          {under("input.subject")}
        </div>
      )}
      {body === undefined ? (
        agentOnly(t("workflows.mail.text"))
      ) : (
        <div className="grid gap-2" data-mail-field="body">
          <TemplateTextField
            label={t("workflows.mail.text")}
            value={body}
            options={fields}
            multiline
            rows={8}
            required
            placeholder={t("workflows.mail.bodyPlaceholder")}
            error={textMissing("body", body, t("workflows.mail.bodyMissing"))}
            labelEnd={
              <SegmentedControl
                size="sm"
                label={t("workflows.mail.text")}
                value={view}
                onValueChange={(next) => setView(next === "preview" ? "preview" : "write")}
              >
                <SegmentedControlItem value="write">
                  {t("workflows.mail.write")}
                </SegmentedControlItem>
                <SegmentedControlItem value="preview">
                  {t("workflows.mail.previewTab")}
                </SegmentedControlItem>
              </SegmentedControl>
            }
            {...(view === "preview"
              ? {
                  view: (
                    <MailSettingsPreview
                      workflowId={editing.workflowId}
                      from={mailFrom(mail, translation)}
                      recipients={{
                        to: recipients("to") ?? [],
                        cc: recipients("cc") ?? [],
                        bcc: recipients("bcc") ?? []
                      }}
                      subject={subject ?? []}
                      body={body}
                      labelOf={labelOf}
                    />
                  )
                }
              : {})}
            onBlur={left("input.body")}
            onChange={(next) => setInput("body", textInput(next))}
          />
          {under("input.body")}
        </div>
      )}
      <Disclosure>
        <DisclosureTrigger>{t("workflows.mail.more")}</DisclosureTrigger>
        <DisclosureContent>
          <div className="grid gap-4" data-mail-more="">
            {replyUser ? (
              agentOnly(t("workflows.mail.replyTo"))
            ) : (
              <Field
                label={t("workflows.mail.replyTo")}
                optional
                error={
                  issue("input.replyTo") ??
                  (replyAddress !== "" && addressOutside(replyAddress, domains)
                    ? t("workflows.mail.outsideAddress", {
                        domain: replyAddress.slice(replyAddress.lastIndexOf("@") + 1)
                      })
                    : undefined)
                }
              >
                <Input
                  type="email"
                  value={replyAddress}
                  onChange={(event) =>
                    setInput(
                      "replyTo",
                      event.target.value.trim() === ""
                        ? undefined
                        : { value: event.target.value.trim() }
                    )
                  }
                  onBlur={left("input.replyTo")}
                />
              </Field>
            )}
            <Field label={t("workflows.mail.language")} optional error={issue("input.locale")}>
              <Select
                value={locale}
                onChange={(event) =>
                  setInput(
                    "locale",
                    event.target.value === "" ? undefined : { value: event.target.value }
                  )
                }
              >
                <option value="">{t("workflows.mail.languageDefault")}</option>
                <option value="en">{t("workflows.mail.languageEn")}</option>
                <option value="de">{t("workflows.mail.languageDe")}</option>
              </Select>
            </Field>
          </div>
        </DisclosureContent>
      </Disclosure>
    </div>
  );
}

interface PreviewProps {
  workflowId: string;
  from: ReturnType<typeof mailFrom>;
  recipients: Record<RecipientsField, readonly RecipientItem[]>;
  subject: readonly TemplatePart[];
  body: readonly TemplatePart[];
  labelOf(option: string): string;
}

/** The preview of the text: with the values of the Workflow's last run, where it had one. */
function MailSettingsPreview(props: PreviewProps) {
  const { t } = useTranslation();
  const runs = useWorkflowRuns(props.workflowId, 1);
  const last = runs.rows?.[0];
  if (runs.rows === undefined && !runs.failed) {
    return <MailPreview state="loading" label={t("workflows.mail.preview")} />;
  }
  return last === undefined ? (
    <MailSettingsFrame {...props} sample={undefined} />
  ) : (
    <LastRunPreview key={last.id} runId={last.id} {...props} />
  );
}

function LastRunPreview({ runId, ...props }: PreviewProps & { runId: string }) {
  const read = useWorkflowRun(runId);
  return <MailSettingsFrame {...props} sample={sampleOf(read.stepRuns)} />;
}

function MailSettingsFrame({
  from,
  recipients,
  subject,
  body,
  labelOf,
  sample
}: PreviewProps & { sample: Sample | undefined }) {
  const { t } = useTranslation();
  const brand = useMailBrand();
  const valueOf: Sample = sample ?? (() => undefined);
  const shown = (list: readonly RecipientItem[]): MailPreviewRecipient[] =>
    list.map((item) => ({
      label: item.label,
      ...(item.kind === "picked" ? { picked: true } : {})
    }));
  return (
    <div className="grid gap-2" data-mail-settings-preview="">
      <MailPreview
        label={t("workflows.mail.preview")}
        from={from}
        to={shown(recipients.to)}
        cc={shown(recipients.cc)}
        bcc={shown(recipients.bcc)}
        subject={sampleText(subject, valueOf, labelOf, false)}
        {...(brand === undefined ? {} : { brand })}
      >
        <MarkdownArtifact>{sampleText(body, valueOf, labelOf, true)}</MarkdownArtifact>
      </MailPreview>
      <p className="text-caption text-muted-foreground">
        {t(sample === undefined ? "workflows.mail.sampleNone" : "workflows.mail.sampleLast")}
      </p>
    </div>
  );
}
