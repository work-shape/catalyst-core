/** The gallery's text for the CopyText entry. */
export interface CopyTextGalleryText {
  copyTextLabelled: string;
  copyTextPlain: string;
  copyTextNarrow: string;
  copyTextPending: string;
  copyTextLabel: string;
  copyTextMessage: string;
  copyTextShort: string;
  copyTextLong: string;
}

export const copyTextGalleryText: Record<"en" | "de", CopyTextGalleryText> = {
  en: {
    copyTextLabelled: "With a label",
    copyTextPlain: "Without a label",
    copyTextNarrow: "Long text in a narrow column",
    copyTextPending: "Still being written",
    copyTextLabel: "Reply to the supplier",
    copyTextMessage:
      "Hello Ms Okafor,\n\nthank you for the offer. We would like to go ahead with option B and start in the week of 12 January.\n\nCould you confirm the delivery date by Friday?\n\nKind regards\nAlex Meyer",
    copyTextShort: "The meeting moves to Thursday, 10:00, same room.",
    copyTextLong:
      "Summary for the team: the three offers differ mainly in delivery time and in what the price includes. The first is the cheapest and leaves the scaffolding out, the second includes it and delivers two weeks later, the third is the most expensive and the only one with a fixed date.\n\nDetails: https://files.example.com/offers/2026/comparison-of-all-three-offers-with-scaffolding-and-delivery-dates.pdf"
  },
  de: {
    copyTextLabelled: "Mit Bezeichnung",
    copyTextPlain: "Ohne Bezeichnung",
    copyTextNarrow: "Langer Text in einer schmalen Spalte",
    copyTextPending: "Wird noch geschrieben",
    copyTextLabel: "Antwort an den Lieferanten",
    copyTextMessage:
      "Guten Tag Frau Okafor,\n\nvielen Dank für das Angebot. Wir möchten Variante B beauftragen und in der Woche ab dem 12. Januar beginnen.\n\nKönnen Sie den Liefertermin bis Freitag bestätigen?\n\nMit freundlichen Grüßen\nAlex Meyer",
    copyTextShort: "Das Treffen ist jetzt am Donnerstag um 10:00 Uhr, gleicher Raum.",
    copyTextLong:
      "Zusammenfassung für das Team: Die drei Angebote unterscheiden sich vor allem in der Lieferzeit und darin, was der Preis enthält. Das erste ist das günstigste und lässt das Gerüst aus, das zweite enthält es und liefert zwei Wochen später, das dritte ist das teuerste und das einzige mit festem Termin.\n\nEinzelheiten: https://files.example.com/offers/2026/vergleich-aller-drei-angebote-mit-geruest-und-lieferterminen.pdf"
  }
};
