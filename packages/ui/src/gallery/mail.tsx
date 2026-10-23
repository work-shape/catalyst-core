import { Building2, Mail } from "lucide-react";
import { useState } from "react";
import { MailPreview } from "../data/mail-preview";
import { RecipientField, type RecipientItem } from "../forms/recipient-field";
import { TemplateText, TemplateTextField, type TemplatePart } from "../forms/template-text-field";
import type { PickerOptionGroup } from "../overlays/picker";
import { Samples, type GalleryEntry } from "./entry";
import type { GalleryText } from "./text";

/** The values of earlier steps the samples offer, one group per step. */
function stepFields(text: GalleryText): PickerOptionGroup[] {
  return [
    {
      heading: text.mailStepCheck,
      options: [
        { value: "check#month", label: text.mailFieldMonth },
        { value: "check#findings", label: text.mailFieldFindings }
      ]
    },
    {
      heading: text.mailStepLoad,
      options: [
        { value: "load#emails", label: text.mailFieldAddresses },
        { value: "load#client", label: text.mailFieldClient }
      ]
    }
  ];
}

/** A body as the server renders one: a whole document, here without colours of its own. */
function renderedSample(text: GalleryText): string {
  const items = text.mailBodyItems.map((item) => `<li>${item}</li>`).join("");
  return `<!doctype html><html><head><style>body{font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;margin:16px}</style></head><body><p>${text.mailBodyLead}</p><ul>${items}</ul><p>${text.mailBodyClose}</p></body></html>`;
}

function BodySample({ text }: { text: GalleryText }) {
  return (
    <div className="grid gap-2 text-body">
      <p>{text.mailBodyLead}</p>
      <ul className="list-disc pl-5">
        {text.mailBodyItems.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p>{text.mailBodyClose}</p>
    </div>
  );
}

function MailPreviewSamples({ text }: { text: GalleryText }) {
  const from = { name: text.mailSender, address: "office@mail.example.test", icon: <Mail /> };
  const to = [{ label: text.mailPersonOne }, { label: "anna@example.test" }];
  const brand = { name: text.mailInstance, mark: <Building2 aria-hidden /> };
  const subject = (
    <TemplateText
      value={[text.mailSubjectBefore, { option: "check#month" }]}
      options={stepFields(text)}
    />
  );
  return (
    <div className="grid w-full max-w-xl gap-6">
      <Samples label={text.mailStateEmpty}>
        <MailPreview state="empty" label={text.mailPreviewLabel} className="w-full" />
      </Samples>
      <Samples label={text.mailStateLoading}>
        <MailPreview state="loading" label={text.mailPreviewLabel} className="w-full" />
      </Samples>
      <Samples label={text.mailStateRendered}>
        <MailPreview
          label={text.mailPreviewLabel}
          className="w-full"
          from={from}
          to={to}
          cc={[{ label: text.mailWorkspace }]}
          subject={text.mailSubject}
          html={renderedSample(text)}
        />
      </Samples>
      <Samples label={text.mailStateSimulated}>
        <MailPreview
          label={text.mailPreviewLabel}
          className="w-full"
          simulated
          from={from}
          to={[...to, { label: text.mailFieldAddresses, picked: true }]}
          subject={subject}
          brand={brand}
          footer={text.mailFooter}
        >
          <BodySample text={text} />
        </MailPreview>
      </Samples>
      <Samples label={text.mailStateTest}>
        <MailPreview
          label={text.mailPreviewLabel}
          className="w-full"
          test={{ to, cc: [{ label: text.mailWorkspace }] }}
          from={from}
          to={[{ label: text.mailPersonTwo }]}
          subject={text.mailSubject}
          brand={brand}
        >
          <BodySample text={text} />
        </MailPreview>
      </Samples>
      <Samples label={text.mailStateFolded}>
        <MailPreview
          label={text.mailPreviewLabel}
          className="w-full"
          foldLines={4}
          from={from}
          to={to}
          subject={text.mailSubject}
          brand={brand}
        >
          <BodySample text={text} />
        </MailPreview>
      </Samples>
    </div>
  );
}

function RecipientSample({
  text,
  initial,
  readOnly = false,
  pickedAlone = true,
  error
}: {
  text: GalleryText;
  initial: readonly RecipientItem[];
  readOnly?: boolean;
  pickedAlone?: boolean;
  error?: string;
}) {
  const [value, setValue] = useState<readonly RecipientItem[]>(initial);
  return (
    <RecipientField
      label={text.mailTo}
      value={value.map((item) =>
        item.kind === "address" && item.value.endsWith("@outside.test")
          ? { ...item, invalid: text.mailOutside }
          : item
      )}
      onChange={setValue}
      readOnly={readOnly}
      pickedAlone={pickedAlone}
      error={error}
      directory={[
        { kind: "person", value: "u1", label: text.mailPersonOne },
        { kind: "person", value: "u2", label: text.mailPersonTwo },
        { kind: "workspace", value: "w1", label: text.mailWorkspace }
      ]}
      fields={stepFields(text)}
    />
  );
}

function TemplateSample({
  text,
  label,
  initial,
  multiline = false,
  readOnly = false,
  error
}: {
  text: GalleryText;
  label: string;
  initial: readonly TemplatePart[];
  multiline?: boolean;
  readOnly?: boolean;
  error?: string;
}) {
  const [value, setValue] = useState<readonly TemplatePart[]>(initial);
  return (
    <TemplateTextField
      label={label}
      value={value}
      onChange={setValue}
      options={stepFields(text)}
      multiline={multiline}
      readOnly={readOnly}
      error={error}
      placeholder={multiline ? text.mailPlaceholder : undefined}
    />
  );
}

export const mailPreviewEntry: GalleryEntry = {
  name: "MailPreview",
  components: ["MailPreview"],
  render: (text) => <MailPreviewSamples text={text} />
};

export const mailFormEntries: readonly GalleryEntry[] = [
  {
    name: "RecipientField",
    components: ["RecipientField"],
    render: (text) => (
      <div className="grid w-full max-w-md gap-6">
        <RecipientSample text={text} initial={[]} />
        <RecipientSample
          text={text}
          initial={[
            { kind: "person", value: "u1", label: text.mailPersonOne },
            { kind: "workspace", value: "w1", label: text.mailWorkspace },
            { kind: "address", value: "anna@example.test", label: "anna@example.test" }
          ]}
        />
        <RecipientSample
          text={text}
          initial={[
            { kind: "person", value: "u2", label: text.mailPersonTwo },
            { kind: "address", value: "otto@outside.test", label: "otto@outside.test" }
          ]}
        />
        <RecipientSample
          text={text}
          initial={[{ kind: "picked", value: "load#emails", label: text.mailFieldAddresses }]}
        />
        <RecipientSample
          text={text}
          readOnly
          initial={[
            { kind: "person", value: "u1", label: text.mailPersonOne },
            { kind: "address", value: "anna@example.test", label: "anna@example.test" }
          ]}
        />
      </div>
    )
  },
  {
    name: "TemplateTextField",
    components: ["TemplateTextField", "TemplateText"],
    render: (text) => (
      <div className="grid w-full max-w-md gap-6">
        <TemplateSample text={text} label={text.mailSubjectLabel} initial={[]} />
        <TemplateSample
          text={text}
          label={text.mailSubjectLabel}
          initial={[
            text.mailSubjectBefore,
            { option: "check#month" },
            text.mailSubjectBetween,
            { option: "load#client" }
          ]}
        />
        <TemplateSample
          text={text}
          label={text.mailText}
          multiline
          initial={[text.mailTextBefore, { option: "check#findings" }, text.mailTextAfter]}
        />
        <TemplateSample
          text={text}
          label={text.mailSubjectLabel}
          initial={[text.mailSubjectBefore, { option: "check#month" }]}
          readOnly
        />
        <TemplateSample
          text={text}
          label={text.mailSubjectLabel}
          initial={[]}
          error={text.mailSubjectMissing}
        />
        <p className="text-body">
          <TemplateText
            value={[text.mailSubjectBefore, { option: "check#month" }]}
            options={stepFields(text)}
          />
        </p>
      </div>
    )
  }
];
