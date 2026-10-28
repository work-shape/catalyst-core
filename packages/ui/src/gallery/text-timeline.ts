/** The gallery's text for the Timeline entry. */
export interface TimelineGalleryText {
  timelineRun: string;
  timelineLabel: string;
  timelineReplay: string;
  timelineRows: readonly [string, string, string, string, string, string];
  timelineTook: readonly [string, string, string, string, string, string];
}

export const timelineGalleryText: Record<"en" | "de", TimelineGalleryText> = {
  en: {
    timelineRun: "A run that has ended: three paths at the same time, the costs took longest",
    timelineLabel: "Timeline of the run",
    timelineReplay: "Played back to a moment: the bars reach it, the line marks it",
    timelineRows: ["Load the bookings", "Analyses", "Revenue", "Costs", "Risks", "Report"],
    timelineTook: ["38 s", "3 min 33 s", "1 min 54 s", "3 min 33 s", "1 min 11 s", "11 s"]
  },
  de: {
    timelineRun: "Ein beendeter Lauf: drei Zweige gleichzeitig, die Kosten dauerten am längsten",
    timelineLabel: "Zeitverlauf des Laufs",
    timelineReplay:
      "Bis zu einem Zeitpunkt abgespielt: die Balken reichen bis dorthin, die Linie zeigt ihn",
    timelineRows: ["Buchungen laden", "Analysen", "Umsatz", "Kosten", "Risiken", "Bericht"],
    timelineTook: [
      "38 Sek.",
      "3 Min. 33 Sek.",
      "1 Min. 54 Sek.",
      "3 Min. 33 Sek.",
      "1 Min. 11 Sek.",
      "11 Sek."
    ]
  }
};
