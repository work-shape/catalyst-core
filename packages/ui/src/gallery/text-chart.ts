/** The gallery's text for the Chart entry. */
export interface ChartGalleryText {
  /** The locale the sample charts format their numbers and months in. */
  chartLocale: string;
  chartRuns: string;
  chartShare: string;
  chartBar: string;
  chartBarStacked: string;
  chartLine: string;
  chartAreaStacked: string;
  chartPie: string;
  chartSixSeriesLine: string;
  chartSixSeriesBar: string;
  chartTruncated: string;
  chartEmpty: string;
  chartEmptyLabel: string;
  chartSeriesChat: string;
  chartSeriesWorkflows: string;
  chartSeriesApps: string;
  chartSeriesApi: string;
  chartSeriesSchedules: string;
  chartSeriesImports: string;
}

export const chartGalleryText: Record<"en" | "de", ChartGalleryText> = {
  en: {
    chartLocale: "en-US",
    chartRuns: "Runs per month",
    chartShare: "Share of runs by source",
    chartBar: "Bar",
    chartBarStacked: "Bar, stacked",
    chartLine: "Line, with a gap where a value is missing",
    chartAreaStacked: "Area, stacked",
    chartPie: "Pie",
    chartSixSeriesLine: "Line, six series: the sixth repeats the first colour, dashed",
    chartSixSeriesBar: "Bar, six series: the sixth repeats the first colour, lighter",
    chartTruncated: "Line, more rows than a chart draws: it says that it cut",
    chartEmpty: "Without rows",
    chartEmptyLabel: "No runs in this period.",
    chartSeriesChat: "Chat",
    chartSeriesWorkflows: "Workflows",
    chartSeriesApps: "Apps",
    chartSeriesApi: "API",
    chartSeriesSchedules: "Schedules",
    chartSeriesImports: "Imports"
  },
  de: {
    chartLocale: "de-DE",
    chartRuns: "Läufe pro Monat",
    chartShare: "Anteil der Läufe nach Quelle",
    chartBar: "Balken",
    chartBarStacked: "Balken, gestapelt",
    chartLine: "Linie, mit einer Lücke, wo ein Wert fehlt",
    chartAreaStacked: "Fläche, gestapelt",
    chartPie: "Kreis",
    chartSixSeriesLine: "Linie, sechs Reihen: die sechste wiederholt die erste Farbe, gestrichelt",
    chartSixSeriesBar: "Balken, sechs Reihen: die sechste wiederholt die erste Farbe, heller",
    chartTruncated: "Linie, mehr Zeilen als ein Diagramm zeichnet: es sagt, dass es gekürzt hat",
    chartEmpty: "Ohne Zeilen",
    chartEmptyLabel: "Keine Läufe in diesem Zeitraum.",
    chartSeriesChat: "Chat",
    chartSeriesWorkflows: "Workflows",
    chartSeriesApps: "Apps",
    chartSeriesApi: "API",
    chartSeriesSchedules: "Zeitpläne",
    chartSeriesImports: "Importe"
  }
};
