/** The gallery's text for the Steps entry. */
export interface StepsGalleryText {
  stepsDescribed: string;
  stepsStates: string;
  stepsNarrow: string;
  stepsListLabel: string;
  stepsInnerLabel: string;
  stepKindStart: string;
  stepKindRead: string;
  stepKindEach: string;
  stepKindScript: string;
  stepKindWrite: string;
  stepKindSummary: string;
  stepKindResult: string;
  stepSource: string;
  stepStartText: string;
  stepReadTitle: string;
  stepReadText: string;
  stepLoadTitle: string;
  stepLoadText: string;
  stepCheckTitle: string;
  stepCheckText: string;
  stepCheckNote: string;
  stepStoreTitle: string;
  stepStoreText: string;
  stepSummaryTitle: string;
  stepSummaryText: string;
  stepSummaryNote: string;
  stepResultText: string;
  stepBadgeChanged: string;
  stepBadgeNew: string;
  stepMetaStart: string;
  stepMetaShort: string;
  stepMetaRunning: string;
  stepMetaWaiting: string;
  stepReadResult: string;
  stepProgressCounts: string;
  stepFailure: string;
  stepFailureNext: string;
  stepOutputLabel: string;
  stepLimitText: string;
  stepCancelledText: string;
}

export const stepsGalleryText: Record<"en" | "de", StepsGalleryText> = {
  en: {
    stepsDescribed: "Described: numbers, a nested list with letters, badges",
    stepsStates: "With states: every state, a body that unfolds, a failed step open",
    stepsNarrow: "In a narrow column",
    stepsListLabel: "What it does",
    stepsInnerLabel: "For each customer",
    stepKindStart: "Starts",
    stepKindRead: "Reads data",
    stepKindEach: "For each customer",
    stepKindScript: "Script",
    stepKindWrite: "Changes data",
    stepKindSummary: "Summary",
    stepKindResult: "Result",
    stepSource: "Accounting",
    stepStartText: "Monthly, on the 1st at 06:00, or when someone starts it",
    stepReadTitle: "Load customers",
    stepReadText: "Fetches the list of all active customers.",
    stepLoadTitle: "Load bookings",
    stepLoadText: "Fetches the bookings of the month before.",
    stepCheckTitle: "Check bookings",
    stepCheckText:
      "Checks every booking against 12 rules, such as duplicate receipt numbers and amounts above the allowance.",
    stepCheckNote: "Runs the same way every time.",
    stepStoreTitle: "Save findings",
    stepStoreText: "Writes every finding into the table of findings.",
    stepSummaryTitle: "Write the summary",
    stepSummaryText: "Sums up the findings per customer in three sentences.",
    stepSummaryNote: "Receives: the result of “Save findings”",
    stepResultText: "The number of customers checked and of findings",
    stepBadgeChanged: "Changed",
    stepBadgeNew: "New",
    stepMetaStart: "06:00",
    stepMetaShort: "4 s",
    stepMetaRunning: "12 min so far",
    stepMetaWaiting: "waiting since 06:12",
    stepReadResult: "600 customers",
    stepProgressCounts: "210 done · 2 failed · 8 running · 380 to go",
    stepFailure: "The script stopped with an error.",
    stepFailureNext: "It was not tried again: an error in the script does not go away by itself.",
    stepOutputLabel: "Output of the step",
    stepLimitText: "The usage limit was reached. It stopped here.",
    stepCancelledText: "Cancelled by Maria Schmidt at 06:14."
  },
  de: {
    stepsDescribed: "Beschrieben: Nummern, eine eingerückte Liste mit Buchstaben, Badges",
    stepsStates: "Mit Zuständen: jeder Zustand, ein aufklappbarer Inhalt, ein offener Fehler",
    stepsNarrow: "In einer schmalen Spalte",
    stepsListLabel: "Was er tut",
    stepsInnerLabel: "Für jeden Kunden",
    stepKindStart: "Startet",
    stepKindRead: "Liest Daten",
    stepKindEach: "Für jeden Kunden",
    stepKindScript: "Skript",
    stepKindWrite: "Ändert Daten",
    stepKindSummary: "Zusammenfassung",
    stepKindResult: "Ergebnis",
    stepSource: "Buchhaltung",
    stepStartText: "Monatlich, am 1. um 06:00 Uhr, oder wenn jemand ihn startet",
    stepReadTitle: "Kunden laden",
    stepReadText: "Holt die Liste aller aktiven Kunden.",
    stepLoadTitle: "Buchungen laden",
    stepLoadText: "Holt die Buchungen des Vormonats.",
    stepCheckTitle: "Buchungen prüfen",
    stepCheckText:
      "Prüft jede Buchung gegen 12 Regeln, etwa doppelte Belegnummern und Beträge über der Freigrenze.",
    stepCheckNote: "Läuft jedes Mal gleich.",
    stepStoreTitle: "Auffälligkeiten speichern",
    stepStoreText: "Schreibt jede Auffälligkeit in die Tabelle der Auffälligkeiten.",
    stepSummaryTitle: "Zusammenfassung schreiben",
    stepSummaryText: "Fasst die Auffälligkeiten je Kunde in drei Sätzen zusammen.",
    stepSummaryNote: "Bekommt: das Ergebnis von „Auffälligkeiten speichern“",
    stepResultText: "Anzahl geprüfter Kunden und Auffälligkeiten",
    stepBadgeChanged: "Geändert",
    stepBadgeNew: "Neu",
    stepMetaStart: "06:00",
    stepMetaShort: "4 s",
    stepMetaRunning: "bisher 12 min",
    stepMetaWaiting: "wartet seit 06:12",
    stepReadResult: "600 Kunden",
    stepProgressCounts: "210 fertig · 2 fehlgeschlagen · 8 laufen · 380 offen",
    stepFailure: "Das Skript ist mit einem Fehler abgebrochen.",
    stepFailureNext:
      "Er wurde nicht wiederholt: Ein Fehler im Skript verschwindet nicht von selbst.",
    stepOutputLabel: "Ausgabe des Schritts",
    stepLimitText: "Das Nutzungslimit wurde erreicht. Hier wurde gestoppt.",
    stepCancelledText: "Abgebrochen von Maria Schmidt um 06:14."
  }
};
