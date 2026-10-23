/** The gallery's text for MailPreview, RecipientField and TemplateTextField. */
export interface MailGalleryText {
  mailPreviewLabel: string;
  mailInstance: string;
  mailSender: string;
  mailSubject: string;
  mailBodyLead: string;
  mailBodyItems: readonly [string, string, string];
  mailBodyClose: string;
  mailFooter: string;
  mailPersonOne: string;
  mailPersonTwo: string;
  mailWorkspace: string;
  mailFieldMonth: string;
  mailFieldFindings: string;
  mailFieldAddresses: string;
  mailFieldClient: string;
  mailStepLoad: string;
  mailStepCheck: string;
  mailStateEmpty: string;
  mailStateLoading: string;
  mailStateRendered: string;
  mailStateSimulated: string;
  mailStateTest: string;
  mailStateFolded: string;
  mailTo: string;
  mailCc: string;
  mailSubjectLabel: string;
  mailText: string;
  mailOutside: string;
  mailSubjectBefore: string;
  mailSubjectBetween: string;
  mailTextBefore: string;
  mailTextAfter: string;
  mailPlaceholder: string;
  mailSubjectMissing: string;
}

export const mailGalleryText: Record<"en" | "de", MailGalleryText> = {
  en: {
    mailPreviewLabel: "The e-mail",
    mailInstance: "Example firm",
    mailSender: "Example firm",
    mailSubject: "Check result September 2026",
    mailBodyLead: "Good morning, the monthly check found three bookings to look at:",
    mailBodyItems: [
      "Invoice 2026-114 has no receipt.",
      "Invoice 2026-131 was booked twice.",
      "Invoice 2026-140 names an unknown supplier."
    ],
    mailBodyClose: "The full list is in the run of the workflow.",
    mailFooter:
      "The workflow “Monthly booking check” of Example firm sent this e-mail automatically.",
    mailPersonOne: "Miriam Voss",
    mailPersonTwo: "Jonas Becker",
    mailWorkspace: "Accounting",
    mailFieldMonth: "Month",
    mailFieldFindings: "Findings",
    mailFieldAddresses: "Client addresses",
    mailFieldClient: "Client name",
    mailStepLoad: "Load the clients",
    mailStepCheck: "Check the bookings",
    mailStateEmpty: "Empty",
    mailStateLoading: "Loading",
    mailStateRendered: "Rendered by the server, in a sandboxed frame",
    mailStateSimulated: "Simulated in a test run",
    mailStateTest: "Test: sent to the tester alone",
    mailStateFolded: "Folded to 4 lines",
    mailTo: "To",
    mailCc: "Cc",
    mailSubjectLabel: "Subject",
    mailText: "Text",
    mailOutside: "This instance does not send to outside.test.",
    mailSubjectBefore: "Check result ",
    mailSubjectBetween: " for ",
    mailTextBefore: "Good morning,\nthe monthly check found these bookings:\n",
    mailTextAfter: "\nKind regards",
    mailPlaceholder: "Write the text of the e-mail",
    mailSubjectMissing: "Write a subject."
  },
  de: {
    mailPreviewLabel: "Die E-Mail",
    mailInstance: "Beispielkanzlei",
    mailSender: "Beispielkanzlei",
    mailSubject: "Prüfergebnis September 2026",
    mailBodyLead:
      "Guten Morgen, die Monatsprüfung hat drei Buchungen gefunden, die ihr euch ansehen solltet:",
    mailBodyItems: [
      "Rechnung 2026-114 hat keinen Beleg.",
      "Rechnung 2026-131 wurde doppelt gebucht.",
      "Rechnung 2026-140 nennt einen unbekannten Lieferanten."
    ],
    mailBodyClose: "Die ganze Liste steht im Lauf des Workflows.",
    mailFooter:
      "Der Workflow „Monatliche Buchungsprüfung“ der Beispielkanzlei hat diese E-Mail automatisch gesendet.",
    mailPersonOne: "Miriam Voss",
    mailPersonTwo: "Jonas Becker",
    mailWorkspace: "Buchhaltung",
    mailFieldMonth: "Monat",
    mailFieldFindings: "Befunde",
    mailFieldAddresses: "Adressen der Mandanten",
    mailFieldClient: "Name des Mandanten",
    mailStepLoad: "Mandanten laden",
    mailStepCheck: "Buchungen prüfen",
    mailStateEmpty: "Leer",
    mailStateLoading: "Lädt",
    mailStateRendered: "Vom Server gerendert, in einem abgeschotteten Rahmen",
    mailStateSimulated: "In einem Testlauf simuliert",
    mailStateTest: "Test: nur an die testende Person gesendet",
    mailStateFolded: "Auf 4 Zeilen eingeklappt",
    mailTo: "An",
    mailCc: "Cc",
    mailSubjectLabel: "Betreff",
    mailText: "Text",
    mailOutside: "Diese Instanz sendet nicht an outside.test.",
    mailSubjectBefore: "Prüfergebnis ",
    mailSubjectBetween: " für ",
    mailTextBefore: "Guten Morgen,\ndie Monatsprüfung hat diese Buchungen gefunden:\n",
    mailTextAfter: "\nViele Grüße",
    mailPlaceholder: "Schreib den Text der E-Mail",
    mailSubjectMissing: "Schreib einen Betreff."
  }
};
