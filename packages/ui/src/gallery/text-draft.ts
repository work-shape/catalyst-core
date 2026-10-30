/** The gallery's text for the parts of a draft: DraftHeader, ChangeList, ChangeTag, TextDiff. */
export interface DraftGalleryText {
  draftStore: string;
  draftConnection: string;
  draftPerson: string;
  draftDate: string;
  draftChanges: string;
  draftTest: string;
  draftNever: string;
  changeActionSend: string;
  changeActionBook: string;
  changeHost: string;
  changeCalls: string;
  changeListLabel: string;
  diffBefore: string;
  diffAfter: string;
  pillDraft: string;
  pillLive: string;
  pillDetails: string;
  pillChanges: string;
  versionedLabel: string;
  versionedLive: string;
  versionedDraft: string;
  versionedLine: string;
}

const versionedLive = [
  "Answer in the language of the question.",
  "Name the source of every figure.",
  "Keep answers short."
].join("\n");

const versionedDraft = [
  "Answer in the language of the question.",
  "Name the source of every figure, with its date.",
  "Keep answers short."
].join("\n");

const versionedLiveDe = [
  "Antworte in der Sprache der Frage.",
  "Nenne zu jeder Zahl die Quelle.",
  "Halte Antworten kurz."
].join("\n");

const versionedDraftDe = [
  "Antworte in der Sprache der Frage.",
  "Nenne zu jeder Zahl die Quelle und ihr Datum.",
  "Halte Antworten kurz."
].join("\n");

const diffBefore = [
  "export function total(rows) {",
  "  let sum = 0;",
  "  for (const row of rows) {",
  "    sum += row.amount;",
  "  }",
  "  return sum;",
  "}",
  "",
  "export function label(row) {",
  "  return row.name;",
  "}",
  "",
  "export const currency = 'EUR';"
].join("\n");

const diffAfter = [
  "export function total(rows) {",
  "  let sum = 0;",
  "  for (const row of rows) {",
  "    sum += row.amount * row.quantity;",
  "  }",
  "  return sum;",
  "}",
  "",
  "export function label(row) {",
  "  return row.name;",
  "}",
  "",
  "export const currency = 'EUR';",
  "export const rounding = 2;"
].join("\n");

export const draftGalleryText: Record<"en" | "de", DraftGalleryText> = {
  en: {
    draftStore: "Clients",
    draftConnection: "Bookkeeping",
    draftPerson: "Tim Berger",
    draftDate: "Oct 12, 2026",
    draftChanges: "2 steps changed, 1 new.",
    draftTest: "Test run",
    draftNever: "A draft that was never published",
    changeActionSend: "send_reminder",
    changeActionBook: "book_payment",
    changeHost: "api.example.org",
    changeCalls: "Calls Bookkeeping · create_booking",
    changeListLabel: "What this publish changes",
    diffBefore,
    diffAfter,
    pillDraft: "Draft · not live",
    pillLive: "Live",
    pillDetails: "Draft version 8 by Tim Berger, Oct 29, 3:03 PM. Live is version 7.",
    pillChanges: "View changes",
    versionedLabel: "Instructions",
    versionedLive,
    versionedDraft,
    versionedLine: "Differs from live in 1 place"
  },
  de: {
    draftStore: "Mandanten",
    draftConnection: "Buchhaltung",
    draftPerson: "Tim Berger",
    draftDate: "12.10.2026",
    draftChanges: "2 Schritte geändert, 1 neu.",
    draftTest: "Testlauf",
    draftNever: "Ein Entwurf, der nie veröffentlicht wurde",
    changeActionSend: "send_reminder",
    changeActionBook: "book_payment",
    changeHost: "api.example.org",
    changeCalls: "Ruft Buchhaltung · create_booking auf",
    changeListLabel: "Was diese Veröffentlichung ändert",
    diffBefore,
    diffAfter,
    pillDraft: "Entwurf · nicht live",
    pillLive: "Live",
    pillDetails: "Entwurfsversion 8 von Tim Berger, 29.10. 15:03. Live ist Version 7.",
    pillChanges: "Unterschiede ansehen",
    versionedLabel: "Anweisungen",
    versionedLive: versionedLiveDe,
    versionedDraft: versionedDraftDe,
    versionedLine: "Weicht an einer Stelle von Live ab"
  }
};
