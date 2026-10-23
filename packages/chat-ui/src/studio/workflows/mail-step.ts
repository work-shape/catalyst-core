import {
  MAIL_SEND_OPERATION,
  MAIL_SENDER_SYSTEM,
  mailDomainAllowed,
  mailDomainOf
} from "@work-shape/catalyst-core";
import type { TranslationContextValue } from "../../shared/i18n";
import type { RecipientNames } from "./recipient-names";
import type {
  WorkflowMailRecipientView,
  WorkflowMailView,
  WorkflowOutputPreview,
  WorkflowStepSource,
  WorkflowTextPartView
} from "./workflow-views";

// A step that sends an e-mail (workflow-canvas 3, 9.2, 9.3; MAIL-3a): an `operation` step on
// `mail.send`. What it sends is read from the step's input as the definition holds it; whom it
// sends as and to which domains it may send, from the instance's step facts. Nothing of the
// transport is read or named.

export const MAIL_OPERATION = MAIL_SEND_OPERATION;

/** The fields of a mail that name its recipients. */
export type MailRecipientField = "to" | "cc" | "bcc";
export const MAIL_SYSTEM_SENDER = MAIL_SENDER_SYSTEM;
/** The icon of the system sender where the assembly registers none under `system-mail`. */
export const MAIL_ICON_FALLBACK = "mail";

type Text = Pick<TranslationContextValue, "locale" | "t">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** A step of the manifest that sends an e-mail. */
export function isMailStep(step: Readonly<Record<string, unknown>> | undefined): boolean {
  return step?.type === "operation" && step.operation === MAIL_OPERATION;
}

/** Where a field of an earlier result comes from, in the words of the screens. */
export type FieldRefResolver = (ref: { step: string; path: string }) => {
  from: WorkflowStepSource;
  field: string;
};

function refOf(value: unknown, resolve: FieldRefResolver) {
  if (!isRecord(value) || !isRecord(value.ref)) return undefined;
  const step = text(value.ref.step);
  const path = typeof value.ref.path === "string" ? value.ref.path : undefined;
  if (step === undefined || path === undefined) return undefined;
  return { step, path, ...resolve({ step, path }) };
}

/** A text field of the input as parts: written text, and the fields of earlier results. */
export function mailTextOf(
  value: unknown,
  resolve: FieldRefResolver
): WorkflowTextPartView[] | undefined {
  if (!isRecord(value)) return undefined;
  if ("value" in value) return typeof value.value === "string" ? [value.value] : undefined;
  const ref = refOf(value, resolve);
  if (ref !== undefined) return [{ ref }];
  if (Array.isArray(value.text)) {
    const parts: WorkflowTextPartView[] = [];
    for (const part of value.text) {
      if (typeof part === "string") parts.push(part);
      else {
        const found = refOf(part, resolve);
        if (found === undefined) return undefined;
        parts.push({ ref: found });
      }
    }
    return parts;
  }
  return undefined;
}

function literalRecipient(entry: unknown): WorkflowMailRecipientView | undefined {
  if (typeof entry === "string") return { kind: "address", address: entry };
  if (!isRecord(entry)) return undefined;
  const address = text(entry.address) ?? text(entry.email);
  if (address !== undefined) return { kind: "address", address };
  const user = text(entry.user);
  if (user !== undefined) return { kind: "user", id: user };
  const workspace = text(entry.workspace);
  if (workspace !== undefined) return { kind: "workspace", id: workspace };
  return undefined;
}

/**
 * A recipient field of the input as recipients: a literal list, or the one field of an earlier
 * result that gives the list when the step runs. Nothing for a form the screens do not read.
 */
export function mailRecipientsOf(
  value: unknown,
  resolve: FieldRefResolver
): WorkflowMailRecipientView[] | undefined {
  if (value === undefined) return [];
  if (!isRecord(value)) return undefined;
  if ("value" in value) {
    const list = Array.isArray(value.value) ? value.value : [value.value];
    const read = list.map(literalRecipient);
    return read.every((entry) => entry !== undefined) ? read : undefined;
  }
  const ref = refOf(value, resolve);
  return ref === undefined ? undefined : [{ kind: "picked", ref }];
}

/** The mail a step sends, from its input and the step facts the instance gave for it. */
export function mailViewOf(
  input: unknown,
  fact: Readonly<Record<string, unknown>> | undefined,
  resolve: FieldRefResolver
): WorkflowMailView {
  const given = isRecord(input) ? input : {};
  const sender = isRecord(fact?.mailSender) ? fact.mailSender : undefined;
  const source = isRecord(fact?.source) ? fact.source : undefined;
  const senderId = isRecord(given.sender) ? text(given.sender.value) : undefined;
  const literal = (field: string) =>
    isRecord(given[field]) && "value" in given[field] ? given[field].value : undefined;
  const replyTo = literal("replyTo");
  const replyAddress =
    typeof replyTo === "string" ? replyTo : isRecord(replyTo) ? text(replyTo.address) : undefined;
  const replyUser = isRecord(replyTo) ? text(replyTo.user) : undefined;
  const domains = Array.isArray(sender?.recipientDomains)
    ? sender.recipientDomains.filter((domain): domain is string => typeof domain === "string")
    : undefined;
  const title = text(sender?.title) ?? text(source?.title);
  const address = text(sender?.address);
  const icon = text(sender?.icon) ?? text(source?.service);
  const subject = mailTextOf(given.subject, resolve);
  const body = mailTextOf(given.body, resolve);
  const senderName = text(literal("senderName"));
  const locale = text(literal("locale"));
  const recipients = (field: MailRecipientField) => mailRecipientsOf(given[field], resolve);
  const to = recipients("to");
  const cc = recipients("cc");
  const bcc = recipients("bcc");
  return {
    sender: senderId ?? MAIL_SYSTEM_SENDER,
    ...(title === undefined ? {} : { senderTitle: title }),
    ...(address === undefined ? {} : { senderAddress: address }),
    ...(icon === undefined ? {} : { icon }),
    ...(domains === undefined ? {} : { recipientDomains: domains }),
    ...(to === undefined ? { unshown: ["to"] } : { to }),
    ...(cc === undefined ? {} : { cc }),
    ...(bcc === undefined ? {} : { bcc }),
    ...(subject === undefined ? {} : { subject }),
    ...(body === undefined ? {} : { body }),
    ...(senderName === undefined ? {} : { senderName }),
    ...(replyAddress === undefined ? {} : { replyTo: replyAddress }),
    ...(replyUser === undefined ? {} : { replyToUser: replyUser }),
    ...(locale === undefined ? {} : { locale })
  };
}

/** Whether an address lies outside the domains the instance may send to. */
export function addressOutside(address: string, domains: readonly string[] | undefined): boolean {
  if (domains === undefined || !address.includes("@")) return false;
  return !mailDomainAllowed(mailDomainOf(address), domains);
}

/** A field of an earlier result in words: "Client addresses from Load the clients". */
export function fieldRefWords(
  ref: { from: WorkflowStepSource; field: string },
  { t }: Pick<Text, "t">
): string {
  switch (ref.from.from) {
    case "step":
      return t("workflows.mail.fieldFrom", { field: ref.field, step: ref.from.name });
    case "run_input":
      return t("workflows.mail.fieldOfStart", { field: ref.field });
    case "loop_entry":
      return t("workflows.mail.fieldOfEntry", {
        field: ref.field,
        item: ref.from.itemName ?? t("workflows.step.sourceEntry")
      });
  }
}

/** A recipient by name: a person or workspace the reader may read, an address as written. */
export function recipientWords(
  recipient: WorkflowMailRecipientView,
  names: RecipientNames,
  translation: Text
): string {
  const { t } = translation;
  switch (recipient.kind) {
    case "user":
      return names.people.get(recipient.id) ?? t("workflows.recipients.peopleOne", { count: "1" });
    case "workspace":
      return (
        names.workspaces.get(recipient.id) ??
        t("workflows.recipients.workspacesOne", { count: "1" })
      );
    case "address":
      return recipient.address;
    case "picked":
      return fieldRefWords(recipient.ref, translation);
  }
}

/** All recipients of the mail, in the order To, Cc, Bcc. */
function allRecipients(mail: WorkflowMailView): WorkflowMailRecipientView[] {
  return [...(mail.to ?? []), ...(mail.cc ?? []), ...(mail.bcc ?? [])];
}

/** A text of parts on one line, each field of a result in brackets: "Check result [Month]". */
function partsInWords(parts: readonly WorkflowTextPartView[] | undefined): string {
  return (parts ?? [])
    .map((part) => (typeof part === "string" ? part : `[${part.ref.field}]`))
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * The line on the node: the first recipient and how many more, and the subject. "To Miriam
 * Voss and 2 more · Check result [Month]".
 */
export function mailSummary(
  mail: WorkflowMailView,
  names: RecipientNames,
  translation: Text
): string | undefined {
  const { t, locale } = translation;
  const recipients = allRecipients(mail);
  const first = recipients[0];
  const to =
    first === undefined
      ? undefined
      : recipients.length === 1
        ? t("workflows.mail.toOne", {
            first:
              first.kind === "picked" ? first.ref.field : recipientWords(first, names, translation)
          })
        : t("workflows.mail.toMore", {
            first:
              first.kind === "picked" ? first.ref.field : recipientWords(first, names, translation),
            count: (recipients.length - 1).toLocaleString(locale)
          });
  const subject = partsInWords(mail.subject);
  const line = [to, subject === "" ? undefined : subject].filter((part) => part !== undefined);
  return line.length === 0 ? undefined : line.join(" · ");
}

/** "Sends “Check result [Month]” to Miriam Voss and Accounting as Example firm." */
export function mailSentence(
  mail: WorkflowMailView,
  names: RecipientNames,
  translation: Text
): string {
  const { t, locale } = translation;
  const recipients = allRecipients(mail).map((recipient) =>
    recipientWords(recipient, names, translation)
  );
  const to =
    recipients.length === 0
      ? t("workflows.mail.nobody")
      : new Intl.ListFormat(locale, { type: "conjunction" }).format(recipients);
  const sender = mail.senderName ?? mail.senderTitle ?? t("workflows.mail.systemSender");
  const subject = partsInWords(mail.subject);
  return subject === ""
    ? t("workflows.mail.sentenceNoSubject", { to, sender })
    : t("workflows.mail.sentence", { subject, to, sender });
}

/**
 * The start of a JSON text that was cut, read as far as it goes: an open string, list or
 * record is closed where the cut left it, and a key without its value is dropped. Nothing
 * where even that cannot be read.
 */
export function readCutJson(cut: string): unknown {
  try {
    return JSON.parse(cut);
  } catch {
    // Read on below.
  }
  const closers: string[] = [];
  let inString = false;
  let escaped = false;
  // Where the text can be cut and closed: after a whole value of a list or a record.
  let safe = -1;
  let safeClosers: string[] = [];
  for (let index = 0; index < cut.length; index++) {
    const char = cut[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") closers.push("}");
    else if (char === "[") closers.push("]");
    else if (char === "}" || char === "]") {
      closers.pop();
      safe = index + 1;
      safeClosers = [...closers];
    } else if (char === ",") {
      safe = index;
      safeClosers = [...closers];
    }
  }
  // A string cut in the middle is kept up to the cut, closed, where it is a value.
  if (inString) {
    let open = cut.length - 1;
    for (let at = cut.length - 1; at >= 0; at--) {
      if (cut[at] === '"' && cut[at - 1] !== "\\") {
        open = at;
        break;
      }
    }
    const before = cut.slice(0, open).trimEnd();
    if (before.endsWith(":") || before.endsWith("[") || before.endsWith(",")) {
      const kept = cut.replace(/\\u[0-9a-fA-F]{0,3}$|\\$/u, "");
      const attempt = `${kept}"${[...closers].reverse().join("")}`;
      try {
        return JSON.parse(attempt);
      } catch {
        // Fall back to the last whole value.
      }
    }
  }
  if (safe < 0) return undefined;
  try {
    return JSON.parse(`${cut.slice(0, safe)}${[...safeClosers].reverse().join("")}`);
  } catch {
    return undefined;
  }
}

/** What a run's preview of a value holds, read even where it was cut. */
export function previewValue(preview: WorkflowOutputPreview | undefined): unknown {
  return preview === undefined ? undefined : readCutJson(preview.text);
}

/** The value at a dotted path of a value, where it has one. */
export function valueAt(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path === "" ? [] : path.split(".")) {
    if (Array.isArray(current) && /^\d+$/u.test(part)) current = current[Number(part)];
    else if (isRecord(current)) current = current[part];
    else return undefined;
  }
  return current;
}

/** A recipient of the mail a step run got: the input names people and workspaces by id. */
export type MailRunRecipient = Exclude<WorkflowMailRecipientView, { kind: "picked" }>;

/** The mail as a step run sent it, from the input it got after its references were resolved. */
export interface MailRunView {
  to: MailRunRecipient[];
  cc: MailRunRecipient[];
  bcc: MailRunRecipient[];
  subject?: string;
  body?: string;
  /** The input was cut: what is shown is its start. */
  shortened: boolean;
}

function runRecipients(value: unknown): MailRunRecipient[] {
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return list.flatMap((entry): MailRunRecipient[] => {
    // A record of an earlier result gives its `email`; its other fields are not read.
    const found =
      isRecord(entry) && text(entry.email) !== undefined
        ? { kind: "address" as const, address: String(entry.email) }
        : literalRecipient(entry);
    return found === undefined || found.kind === "picked" ? [] : [found];
  });
}

/** The mail a step run got as its input. Nothing where the reader is not given the input. */
export function mailRunOf(input: WorkflowOutputPreview | undefined): MailRunView | undefined {
  const value = previewValue(input);
  if (!isRecord(value)) return undefined;
  const subject = text(value.subject);
  const body = typeof value.body === "string" ? value.body : undefined;
  return {
    to: runRecipients(value.to),
    cc: runRecipients(value.cc),
    bcc: runRecipients(value.bcc),
    ...(subject === undefined ? {} : { subject }),
    ...(body === undefined ? {} : { body }),
    shortened: input?.truncated === true
  };
}

/** What a mail step run answered: sent, sent as a test, or simulated with its preview. */
export type MailRunAnswer =
  | { kind: "sent"; sentAt?: string; count: number; test: boolean; skipped: number }
  | {
      kind: "simulated";
      preview?: {
        from?: { name: string; address: string };
        to: string[];
        cc: string[];
        bcc: string[];
        subject?: string;
        html?: string;
        text?: string;
      };
    };

function previewLabels(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => (isRecord(entry) && text(entry.label) ? [String(entry.label)] : []))
    : [];
}

/** The answer of a mail step run, read from its output. */
export function mailAnswerOf(output: WorkflowOutputPreview | undefined): MailRunAnswer | undefined {
  const value = previewValue(output);
  if (!isRecord(value)) return undefined;
  if (value.simulated === true) {
    const preview = isRecord(value.preview) ? value.preview : undefined;
    if (preview === undefined) return { kind: "simulated" };
    const from = isRecord(preview.from) ? preview.from : undefined;
    const name = text(from?.name);
    const address = text(from?.address);
    const subject = text(preview.subject);
    // A rendered body cut by the preview's bound is no document to draw.
    const html = output?.truncated === true ? undefined : text(preview.html);
    const plain = text(preview.text);
    return {
      kind: "simulated",
      preview: {
        ...(name === undefined || address === undefined ? {} : { from: { name, address } }),
        to: previewLabels(preview.to),
        cc: previewLabels(preview.cc),
        bcc: previewLabels(preview.bcc),
        ...(subject === undefined ? {} : { subject }),
        ...(html === undefined ? {} : { html }),
        ...(plain === undefined ? {} : { text: plain })
      }
    };
  }
  const recipients = isRecord(value.recipients) ? value.recipients : undefined;
  if (recipients === undefined) return undefined;
  const number = (entry: unknown) => (typeof entry === "number" ? entry : 0);
  const sentAt = text(value.sentAt);
  return {
    kind: "sent",
    ...(sentAt === undefined ? {} : { sentAt }),
    count: number(recipients.to) + number(recipients.cc) + number(recipients.bcc),
    test: value.test === true,
    skipped: number(value.skipped)
  };
}

/** The most rows and columns a sample list shows, as EW-TEXT joins a list in Markdown. */
const SAMPLE_MAX_ROWS = 100;
const SAMPLE_MAX_COLUMNS = 8;

function sampleCell(value: unknown): string {
  if (value === undefined || value === null) return "";
  const shown = typeof value === "object" ? JSON.stringify(value) : String(value);
  return shown.replace(/\|/gu, "\\|").replace(/\s*[\r\n]+\s*/gu, " ");
}

/**
 * A value of an earlier result as a Markdown field joins it (EW-TEXT), for a preview: a list of
 * texts as a bulleted list, a list of flat records as a table, anything else as its text.
 */
export function sampleMarkdown(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) {
    const rows = value.slice(0, SAMPLE_MAX_ROWS);
    if (rows.length > 0 && rows.every(isRecord)) {
      const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))].slice(
        0,
        SAMPLE_MAX_COLUMNS
      );
      const line = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
      return [
        "",
        line(columns.map(sampleCell)),
        line(columns.map(() => "---")),
        ...rows.map((row) => line(columns.map((column) => sampleCell(row[column])))),
        ""
      ].join("\n");
    }
    return ["", ...rows.map((row) => `- ${sampleCell(row)}`), ""].join("\n");
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/**
 * A text of parts with the values a run gave its fields, for a preview. A field without a
 * value stands as its name in brackets.
 */
export function sampleText(
  parts: readonly (string | { option: string })[],
  sample: (option: string) => unknown,
  label: (option: string) => string,
  markdown: boolean
): string {
  return parts
    .map((part) => {
      if (typeof part === "string") return part;
      const value = sample(part.option);
      if (value === undefined) return `[${label(part.option)}]`;
      return markdown ? sampleMarkdown(value) : sampleCell(value);
    })
    .join("");
}
