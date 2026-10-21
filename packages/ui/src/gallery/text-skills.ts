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
  connectionIconSizes: string;
  connectionIconUnknownService: string;
  serviceMarkInitial: string;
  serviceMarkLogo: string;
  serviceMarkNeutral: string;
  serviceMarkLedger: string;
  serviceMarkFiles: string;
  starterListLabel: string;
  starterSheet: string;
  starterSheetHint: string;
  starterLetter: string;
  starterLetterHint: string;
  starterPlain: string;
  starterPdf: string;
  starterPdfHint: string;
  starterGuide: string;
  starterGuideHint: string;
}

export const skillsGalleryText: Record<"en" | "de", SkillsGalleryText> = {
  en: {
    skillIconSizes:
      "A shipped skill's page or line icon on the neutral tile, and the generic book, in the three sizes",
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
    skillOfferStructure: "Offer structure",
    connectionIconSizes: "The generic Connection and the four categories, in the three sizes",
    connectionIconUnknownService: "A service nobody registered: its category, else the generic one",
    serviceMarkInitial:
      "The white initial on the service's colour, with its name, in the three sizes",
    serviceMarkLogo: "A logo the service's owner permits, drawn unchanged; and without the name",
    serviceMarkNeutral: "No colour given: the neutral tile",
    serviceMarkLedger: "Ledger",
    serviceMarkFiles: "Files",
    starterListLabel: "Suggestions to start with",
    starterSheet: "Turn a list into a spreadsheet",
    starterSheetHint: "With formulas and a chart",
    starterLetter: "Draft a letter",
    starterLetterHint: "As a document",
    starterPlain: "Simplify a text",
    starterPdf: "Pull figures out of a PDF",
    starterPdfHint: "Into a table",
    starterGuide: "Ask how this platform works",
    starterGuideHint: "Agents, skills and Connections"
  },
  de: {
    skillIconSizes:
      "Die Seite oder das Liniensymbol auf der neutralen Kachel eines mitgelieferten Skills und das allgemeine Buch, in den drei Größen",
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
    skillOfferStructure: "Angebotsaufbau",
    connectionIconSizes: "Die allgemeine Connection und die vier Kategorien, in den drei Größen",
    connectionIconUnknownService:
      "Ein Dienst, den niemand registriert hat: seine Kategorie, sonst das allgemeine Symbol",
    serviceMarkInitial:
      "Der weiße Anfangsbuchstabe auf der Farbe des Dienstes, mit dem Namen, in den drei Größen",
    serviceMarkLogo:
      "Ein Logo, das der Inhaber des Dienstes erlaubt, unverändert; und ohne den Namen",
    serviceMarkNeutral: "Ohne Farbe: die neutrale Kachel",
    serviceMarkLedger: "Hauptbuch",
    serviceMarkFiles: "Dateien",
    starterListLabel: "Vorschläge für den Einstieg",
    starterSheet: "Aus einer Liste eine Tabelle machen",
    starterSheetHint: "Mit Formeln und einem Diagramm",
    starterLetter: "Einen Brief entwerfen",
    starterLetterHint: "Als Dokument",
    starterPlain: "Einen Text vereinfachen",
    starterPdf: "Zahlen aus einem PDF ziehen",
    starterPdfHint: "In eine Tabelle",
    starterGuide: "Fragen, wie die Plattform funktioniert",
    starterGuideHint: "Agenten, Skills und Connections"
  }
};
