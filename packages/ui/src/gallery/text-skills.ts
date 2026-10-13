/** The gallery's text for the skill icon, the "Knows how to" line and the picker of skills. */
export interface SkillsGalleryText {
  skillIconSizes: string;
  skillIconInChip: string;
  skillKnowsHowTo: string;
  skillKnowsHowToLabel: string;
  skillPickerLabel: string;
  skillPickerNote: string;
  skillSpreadsheets: string;
  skillSpreadsheetsSummary: string;
  skillDocuments: string;
  skillDocumentsSummary: string;
  skillPresentations: string;
  skillPresentationsSummary: string;
  skillPdf: string;
  skillPdfSummary: string;
  skillPlainLanguage: string;
  skillPlainLanguageSummary: string;
  skillOfferStructure: string;
}

export const skillsGalleryText: Record<"en" | "de", SkillsGalleryText> = {
  en: {
    skillIconSizes: "A shipped skill's page and the generic book, in the three sizes",
    skillIconInChip: "In a chip",
    skillKnowsHowTo: "The line on a card",
    skillKnowsHowToLabel: "Knows how to",
    skillPickerLabel: "Choose skills",
    skillPickerNote: "A skill is instructions the agent follows. It adds no tools.",
    skillSpreadsheets: "Spreadsheets",
    skillSpreadsheetsSummary:
      "Knows how to build a spreadsheet that calculates, and to check it before handing it over.",
    skillDocuments: "Documents",
    skillDocumentsSummary: "Knows how to lay out a document and check it page by page.",
    skillPresentations: "Presentations",
    skillPresentationsSummary: "Knows how to build a deck and check every slide.",
    skillPdf: "PDF",
    skillPdfSummary: "Knows how to read, fill and assemble PDFs, and to verify the result.",
    skillPlainLanguage: "Plain language",
    skillPlainLanguageSummary: "Knows how to write short, easy sentences in German and English.",
    skillOfferStructure: "Offer structure"
  },
  de: {
    skillIconSizes:
      "Die Seite eines mitgelieferten Skills und das allgemeine Buch, in den drei Größen",
    skillIconInChip: "In einem Chip",
    skillKnowsHowTo: "Die Zeile auf einer Karte",
    skillKnowsHowToLabel: "Weiß, wie man",
    skillPickerLabel: "Skills auswählen",
    skillPickerNote:
      "Ein Skill ist eine Anleitung, der der Agent folgt. Er bringt keine Werkzeuge mit.",
    skillSpreadsheets: "Tabellen",
    skillSpreadsheetsSummary:
      "Weiß, wie man eine Tabelle baut, die rechnet, und sie vor der Übergabe prüft.",
    skillDocuments: "Dokumente",
    skillDocumentsSummary: "Weiß, wie man ein Dokument setzt und Seite für Seite prüft.",
    skillPresentations: "Präsentationen",
    skillPresentationsSummary: "Weiß, wie man Folien baut und jede einzelne prüft.",
    skillPdf: "PDF",
    skillPdfSummary:
      "Weiß, wie man PDFs liest, ausfüllt und zusammenstellt und das Ergebnis prüft.",
    skillPlainLanguage: "Einfache Sprache",
    skillPlainLanguageSummary:
      "Weiß, wie man kurze, einfache Sätze auf Deutsch und Englisch schreibt.",
    skillOfferStructure: "Angebotsaufbau"
  }
};
