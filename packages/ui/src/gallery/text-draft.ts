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
}

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
    diffAfter
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
    diffAfter
  }
};
