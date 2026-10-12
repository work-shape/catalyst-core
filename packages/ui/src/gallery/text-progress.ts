/** The gallery's text for the Progress entry. */
export interface ProgressGalleryText {
  progressTones: string;
  progressSmall: string;
  progressParts: string;
  progressUnknown: string;
  progressNarrow: string;
  progressStorage: string;
  progressStorageLow: string;
  progressStorageHigh: string;
  progressStorageFull: string;
  progressEntries: string;
  progressEntriesEarly: string;
  progressEntriesLate: string;
  progressEntriesLong: string;
  progressWorking: string;
}

export const progressGalleryText: Record<"en" | "de", ProgressGalleryText> = {
  en: {
    progressTones: "One amount: neutral, warning near the limit, danger at the limit",
    progressSmall: "Small, without the amount in words",
    progressParts: "Shares in one bar: what worked and what failed",
    progressUnknown: "Amount unknown",
    progressNarrow: "In a narrow column, with a long amount",
    progressStorage: "Storage used",
    progressStorageLow: "212 MB of 5 GB · 4 %",
    progressStorageHigh: "4.2 GB of 5 GB · 84 %",
    progressStorageFull: "5 GB of 5 GB · 100 %",
    progressEntries: "Entries done",
    progressEntriesEarly: "212 of 600",
    progressEntriesLate: "598 of 600",
    progressEntriesLong: "1,284 of 12,000 entries",
    progressWorking: "Working"
  },
  de: {
    progressTones: "Eine Menge: neutral, Warnung nahe am Limit, Gefahr am Limit",
    progressSmall: "Klein, ohne die Menge in Worten",
    progressParts: "Anteile in einem Balken: was geklappt hat und was fehlgeschlagen ist",
    progressUnknown: "Menge unbekannt",
    progressNarrow: "In einer schmalen Spalte, mit einer langen Menge",
    progressStorage: "Belegter Speicher",
    progressStorageLow: "212 MB von 5 GB · 4 %",
    progressStorageHigh: "4,2 GB von 5 GB · 84 %",
    progressStorageFull: "5 GB von 5 GB · 100 %",
    progressEntries: "Erledigte Einträge",
    progressEntriesEarly: "212 von 600",
    progressEntriesLate: "598 von 600",
    progressEntriesLong: "1.284 von 12.000 Einträgen",
    progressWorking: "In Arbeit"
  }
};
