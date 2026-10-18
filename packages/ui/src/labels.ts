/**
 * The generic texts library components show or announce by themselves. Text that names an
 * object, such as an icon button's label, is a prop of the component that shows it.
 */
export interface UiLabels {
  close: string;
  cancel: string;
  dismiss: string;
  remove: string;
  clear: string;
  search: string;
  noResults: string;
  loading: string;
  copy: string;
  copied: string;
  /** Beside the switch of a `CodeFile` that breaks long lines. */
  wrapLines: string;
  showMore: string;
  showLess: string;
  expand: string;
  collapse: string;
  required: string;
  optional: string;
  /** What the marker of a `Step` in this state says to someone who does not see it. */
  stateQueued: string;
  stateRunning: string;
  stateWaiting: string;
  stateDone: string;
  /** A repeated part of a graph that ended with some of its entries failed. */
  stateDoneWithFailures: string;
  stateFailed: string;
  stateCancelled: string;
  stateLimitReached: string;
  /** A part of a graph that was not reached or lies on a path that was not taken. */
  stateSkipped: string;
  /** What a `TargetBadge` says of a call: made for real, made against a test target, simulated. */
  targetLive: string;
  targetTest: string;
  targetSimulated: string;
  /** The button of `RunLiveOnce`. */
  runLiveOnce: string;
  /** The controls of a `FlowCanvas`. */
  flowZoomIn: string;
  flowZoomOut: string;
  flowFit: string;
  flowTidy: string;
  /** Names the small picture of the whole graph. */
  flowMinimap: string;
  /** In the box of a canvas whose engine could not be loaded. */
  flowLoadFailed: string;
  /** What a count beside a label says to someone who does not see it, for one and for more. */
  countOne: string;
  /** `{count}` stands for the number. */
  countMany: string;
  /** Under a chart that drew only the first rows or series of its data. */
  chartTruncated: string;
  /** In the box of a chart whose engine could not be loaded. */
  chartLoadFailed: string;
  /** Names a `PageOutline`: the list of the sections of the page it stands on. */
  onThisPage: string;
  /** Said of a section a `PageOutline` marks because a field in it has an error. */
  sectionHasError: string;
  /** Names the "…" button of a `PageHeader`, whose menu holds the actions the row has no room for. */
  moreActions: string;
}

export const uiLabelsEn: UiLabels = {
  close: "Close",
  cancel: "Cancel",
  dismiss: "Dismiss",
  remove: "Remove",
  clear: "Clear",
  search: "Search",
  noResults: "No results",
  loading: "Loading",
  copy: "Copy",
  copied: "Copied",
  wrapLines: "Wrap lines",
  showMore: "Show more",
  showLess: "Show less",
  expand: "Expand",
  collapse: "Collapse",
  required: "Required",
  optional: "Optional",
  stateQueued: "Queued",
  stateRunning: "Running",
  stateWaiting: "Waiting",
  stateDone: "Done",
  stateDoneWithFailures: "Done with failures",
  stateFailed: "Failed",
  stateCancelled: "Cancelled",
  stateLimitReached: "Limit reached",
  stateSkipped: "Skipped",
  targetLive: "Live",
  targetTest: "Test",
  targetSimulated: "Simulated",
  runLiveOnce: "Run live once",
  flowZoomIn: "Zoom in",
  flowZoomOut: "Zoom out",
  flowFit: "Show everything",
  flowTidy: "Tidy up",
  flowMinimap: "Overview",
  flowLoadFailed: "The canvas could not be loaded.",
  countOne: "1 item",
  countMany: "{count} items",
  chartTruncated: "Only part of the data is shown.",
  chartLoadFailed: "The chart could not be loaded.",
  onThisPage: "On this page",
  sectionHasError: "Has an error",
  moreActions: "More actions"
};

export const uiLabelsDe: UiLabels = {
  close: "Schließen",
  cancel: "Abbrechen",
  dismiss: "Ausblenden",
  remove: "Entfernen",
  clear: "Leeren",
  search: "Suchen",
  noResults: "Keine Ergebnisse",
  loading: "Lädt",
  copy: "Kopieren",
  copied: "Kopiert",
  wrapLines: "Zeilen umbrechen",
  showMore: "Mehr anzeigen",
  showLess: "Weniger anzeigen",
  expand: "Aufklappen",
  collapse: "Zuklappen",
  required: "Pflichtfeld",
  optional: "Optional",
  stateQueued: "Wartet auf den Start",
  stateRunning: "Läuft",
  stateWaiting: "Wartet",
  stateDone: "Fertig",
  stateDoneWithFailures: "Fertig mit Fehlern",
  stateFailed: "Fehlgeschlagen",
  stateCancelled: "Abgebrochen",
  stateLimitReached: "Limit erreicht",
  stateSkipped: "Übersprungen",
  targetLive: "Live",
  targetTest: "Test",
  targetSimulated: "Simuliert",
  runLiveOnce: "Einmal live ausführen",
  flowZoomIn: "Vergrößern",
  flowZoomOut: "Verkleinern",
  flowFit: "Alles zeigen",
  flowTidy: "Aufräumen",
  flowMinimap: "Übersicht",
  flowLoadFailed: "Die Ansicht konnte nicht geladen werden.",
  countOne: "1 Eintrag",
  countMany: "{count} Einträge",
  chartTruncated: "Nur ein Teil der Daten wird angezeigt.",
  chartLoadFailed: "Das Diagramm konnte nicht geladen werden.",
  onThisPage: "Auf dieser Seite",
  sectionHasError: "Enthält einen Fehler",
  moreActions: "Weitere Aktionen"
};
