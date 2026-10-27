import type { LocaleCode } from "@work-shape/catalyst-core";
import { escapeHtml } from "./markdown";
import type { PlatformReportMailMessage, RenderedMail } from "./types";

// The mail of "Problem an Workshape melden" (PLATFORM-REPORT), to the operator's support
// address. It lists the ids, the code, the instance and the times, and the person's note under
// them. It carries nothing of the conversation: whoever reads it looks the run up on the
// instance, where the worker's cause is kept.

interface ReportCopy {
  subject(instance: string, code: string): string;
  intro(instance: string): string;
  instance: string;
  address: string;
  run: string;
  command: string;
  code: string;
  failedAt: string;
  reportedAt: string;
  note: string;
  noNote: string;
  replies(asked: boolean): string;
  footer: string;
}

const copy: Record<LocaleCode, ReportCopy> = {
  de: {
    subject: (instance, code) => `Plattformproblem in ${instance}: ${code}`,
    intro: (instance) => `In ${instance} hat jemand ein Problem der Plattform gemeldet.`,
    instance: "Instanz",
    address: "Adresse",
    run: "Lauf",
    command: "Befehl",
    code: "Fehlercode",
    failedAt: "Fehler um",
    reportedAt: "Gemeldet um",
    note: "Notiz der Person",
    noNote: "Keine Notiz.",
    replies: (asked) =>
      asked
        ? "Die Person möchte eine Antwort: Antworten auf diese E-Mail gehen an sie."
        : "Die Person hat um keine Antwort gebeten.",
    footer:
      "Diese E-Mail enthält keine Inhalte der Unterhaltung, keine Dateien und keine Protokolle. Den Grund des Fehlers findest du auf der Instanz beim Lauf."
  },
  en: {
    subject: (instance, code) => `Platform problem in ${instance}: ${code}`,
    intro: (instance) => `Someone reported a problem of the platform in ${instance}.`,
    instance: "Instance",
    address: "Address",
    run: "Run",
    command: "Command",
    code: "Error code",
    failedAt: "Failed at",
    reportedAt: "Reported at",
    note: "The person's note",
    noNote: "No note.",
    replies: (asked) =>
      asked
        ? "The person would like an answer: replies to this email go to them."
        : "The person did not ask for an answer.",
    footer:
      "This email holds no content of the conversation, no files and no logs. The cause of the failure is on the instance, with the run."
  }
};

/** One line of a label or an id: a line break or control character could forge another line. */
function oneLine(value: string): string {
  return value.replace(/[\s\p{Cc}]+/gu, " ").trim();
}

/** The note keeps its lines and tabs; other control characters go. */
function noteText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[^\P{Cc}\n\t]/gu, "")
    .trim();
}

export function renderPlatformReport(message: PlatformReportMailMessage): RenderedMail {
  const words = copy[message.locale];
  const { params } = message;
  const instance = oneLine(params.instance.displayName);
  const rows: [string, string][] = [
    [
      words.instance,
      `${instance} (${oneLine(params.instance.id)}, ${oneLine(params.instance.environment)})`
    ],
    ...(params.instance.appUrl
      ? [[words.address, oneLine(params.instance.appUrl)] as [string, string]]
      : []),
    [words.run, oneLine(params.runId)],
    ...(params.commandId ? [[words.command, oneLine(params.commandId)] as [string, string]] : []),
    [words.code, oneLine(params.errorCode)],
    [words.failedAt, oneLine(params.failedAt)],
    [words.reportedAt, oneLine(params.reportedAt)]
  ];
  const note = params.note === undefined ? "" : noteText(params.note);
  const replies = words.replies(message.replyTo !== undefined);
  return {
    to: [message.to],
    ...(message.replyTo ? { replyTo: message.replyTo } : {}),
    subject: words.subject(instance, oneLine(params.errorCode)),
    text: [
      words.intro(instance),
      rows.map(([label, value]) => `${label}: ${value}`).join("\n"),
      `${words.note}:\n${note || words.noNote}`,
      replies,
      words.footer
    ].join("\n\n"),
    html: [
      `<p>${escapeHtml(words.intro(instance))}</p>`,
      `<table>${rows
        .map(
          ([label, value]) =>
            `<tr><th align="left">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`
        )
        .join("")}</table>`,
      `<p><strong>${escapeHtml(words.note)}</strong></p>`,
      `<p style="white-space:pre-wrap">${escapeHtml(note || words.noNote)}</p>`,
      `<p>${escapeHtml(replies)}</p>`,
      `<p>${escapeHtml(words.footer)}</p>`
    ].join("\n")
  };
}
