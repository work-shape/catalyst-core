import type { LocaleCode, MailPreviewRecipient } from "@work-shape/catalyst-core";
import { escapeHtml, renderMailMarkdown } from "./markdown";
import type {
  InlineMailImage,
  MailSenderIdentity,
  RenderedMail,
  WorkflowMessageMailMessage
} from "./types";

// The template `workflow-message`: the mail of `mail.send` in the instance's frame. The frame
// is the instance's name and logo (embedded, never loaded from a host), its accent colour, a
// footer that says who sent the mail, and the operator's legal footer where release config
// sets one. Everything of the message is escaped; its body is rendered by `markdown.ts`.

/** The accent colour where the frame names none or one that is no colour. */
export const DEFAULT_MAIL_ACCENT_COLOR = "#b5573a";

const COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu;

interface FrameCopy {
  sentByWorkflow(workflowName: string, instance: string): string;
  sentByAgent(person: string, instance: string): string;
  testHeading: string;
  testIntro: string;
  testSubjectPrefix: string;
  nobody: string;
}

const frameCopy: Record<LocaleCode, FrameCopy> = {
  en: {
    sentByWorkflow: (workflow, instance) =>
      `The Workflow "${workflow}" of ${instance} sent this e-mail automatically.`,
    sentByAgent: (person, instance) =>
      `An agent of ${instance} sent this e-mail on behalf of ${person}.`,
    testHeading: "Test send",
    testIntro: "This e-mail went to you alone. It would have gone to:",
    testSubjectPrefix: "[Test] ",
    nobody: "nobody"
  },
  de: {
    sentByWorkflow: (workflow, instance) =>
      `Der Workflow „${workflow}“ von ${instance} hat diese E-Mail automatisch gesendet.`,
    sentByAgent: (person, instance) =>
      `Ein Agent von ${instance} hat diese E-Mail im Auftrag von ${person} gesendet.`,
    testHeading: "Testversand",
    testIntro: "Diese E-Mail ging nur an dich. Sie wäre gegangen an:",
    testSubjectPrefix: "[Test] ",
    nobody: "niemanden"
  }
};

/** A colour the frame may use: `#rgb` or `#rrggbb`, else the default. */
export function mailAccentColor(value: string | undefined): string {
  return value !== undefined && COLOR_PATTERN.test(value) ? value : DEFAULT_MAIL_ACCENT_COLOR;
}

export function renderWorkflowMessage(
  message: WorkflowMessageMailMessage,
  identity: MailSenderIdentity,
  logo?: { src: string; image: InlineMailImage }
): RenderedMail {
  const copy = frameCopy[message.locale];
  const { params } = message;
  const accent = mailAccentColor(identity.frame?.accentColor);
  const instance = oneLine(identity.productName);
  const body = renderMailMarkdown(params.markdown, { accentColor: accent });
  const sentBy =
    params.sentBy.kind === "workflow"
      ? copy.sentByWorkflow(oneLine(params.sentBy.workflowName), instance)
      : copy.sentByAgent(oneLine(params.sentBy.onBehalfOf), instance);
  const legal = identity.frame?.footer?.[message.locale]?.trim();
  const subject = `${params.test ? copy.testSubjectPrefix : ""}${params.subject}`;
  const test = params.test ? testLines(params.test.intendedRecipients, copy) : undefined;

  const header = logo
    ? `<img src="${escapeHtml(logo.src)}" alt="${escapeHtml(instance)}" height="40" style="display:block;height:40px;width:auto;max-width:240px;border:0;">`
    : `<span style="font-size:18px;font-weight:bold;color:#1f1f1f;">${escapeHtml(instance)}</span>`;
  const testBox = test
    ? `<tr><td style="padding:0 32px 8px;"><div style="border:1px solid ${accent};border-radius:4px;padding:10px 12px;font-size:13px;line-height:1.5;color:#1f1f1f;"><strong>${escapeHtml(copy.testHeading)}</strong><br>${escapeHtml(copy.testIntro)}<br>${test.map(escapeHtml).join("<br>")}</div></td></tr>`
    : "";
  const footer = [
    `<p style="margin:0 0 8px;">${escapeHtml(sentBy)}</p>`,
    ...(legal ? [`<p style="margin:0;">${multiline(legal)}</p>`] : [])
  ].join("");
  const html = [
    "<!doctype html>",
    `<html lang="${message.locale}">`,
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(subject)}</title></head>`,
    '<body style="margin:0;padding:0;background:#f5f5f3;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f3;">',
    '<tr><td align="center" style="padding:24px 12px;">',
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-top:4px solid ${accent};font-family:Helvetica,Arial,sans-serif;">`,
    `<tr><td style="padding:24px 32px 16px;">${header}</td></tr>`,
    testBox,
    `<tr><td style="padding:8px 32px 24px;font-size:15px;line-height:1.55;color:#1f1f1f;">${body.html}</td></tr>`,
    `<tr><td style="padding:16px 32px 24px;border-top:1px solid #e8e8e6;font-size:12px;line-height:1.5;color:#6b6b6b;">${footer}</td></tr>`,
    "</table>",
    "</td></tr></table>",
    "</body></html>"
  ].join("\n");
  const text = [
    ...(test ? [[copy.testHeading, copy.testIntro, ...test].join("\n")] : []),
    body.text,
    "--",
    sentBy,
    ...(legal ? [legal] : [])
  ]
    .filter((part) => part !== "")
    .join("\n\n");
  return {
    to: message.to,
    ...(message.cc && message.cc.length > 0 ? { cc: message.cc } : {}),
    ...(message.bcc && message.bcc.length > 0 ? { bcc: message.bcc } : {}),
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    ...(message.fromName ? { fromName: message.fromName } : {}),
    subject,
    text,
    html,
    ...(logo && !logo.src.startsWith("data:") ? { inlineImages: [logo.image] } : {})
  };
}

function testLines(
  intended: Record<"to" | "cc" | "bcc", readonly MailPreviewRecipient[]>,
  copy: FrameCopy
): string[] {
  const names = (list: readonly MailPreviewRecipient[]) =>
    list.length === 0 ? copy.nobody : list.map((recipient) => oneLine(recipient.label)).join(", ");
  return [
    `To: ${names(intended.to)}`,
    ...(intended.cc.length > 0 ? [`Cc: ${names(intended.cc)}`] : []),
    ...(intended.bcc.length > 0 ? [`Bcc: ${names(intended.bcc)}`] : [])
  ];
}

/** A value of one line: line breaks and control characters become one space. */
function oneLine(value: string): string {
  return value.replace(/[\s\p{Cc}]+/gu, " ").trim();
}

function multiline(value: string): string {
  return value
    .split(/\r?\n/u)
    .map((line) => escapeHtml(line))
    .join("<br>");
}
