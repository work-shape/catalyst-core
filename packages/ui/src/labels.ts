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
  stateFailed: string;
  stateCancelled: string;
  stateLimitReached: string;
  /** A part of a graph that was not reached or lies on a path that was not taken. */
  stateSkipped: string;
  /** The controls of a `FlowCanvas`. */
  flowZoomIn: string;
  flowZoomOut: string;
  flowFit: string;
  flowTidy: string;
  /** Names the small picture of the whole graph. */
  flowMinimap: string;
  /** In the box of a canvas whose engine could not be loaded. */
  flowLoadFailed: string;
  /** Under a chart that drew only the first rows or series of its data. */
  chartTruncated: string;
  /** In the box of a chart whose engine could not be loaded. */
  chartLoadFailed: string;
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
  stateFailed: "Failed",
  stateCancelled: "Cancelled",
  stateLimitReached: "Limit reached",
  stateSkipped: "Skipped",
  flowZoomIn: "Zoom in",
  flowZoomOut: "Zoom out",
  flowFit: "Show everything",
  flowTidy: "Tidy up",
  flowMinimap: "Overview",
  flowLoadFailed: "The canvas could not be loaded.",
  chartTruncated: "Only part of the data is shown.",
  chartLoadFailed: "The chart could not be loaded."
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
  stateFailed: "Fehlgeschlagen",
  stateCancelled: "Abgebrochen",
  stateLimitReached: "Limit erreicht",
  stateSkipped: "Übersprungen",
  flowZoomIn: "Vergrößern",
  flowZoomOut: "Verkleinern",
  flowFit: "Alles zeigen",
  flowTidy: "Aufräumen",
  flowMinimap: "Übersicht",
  flowLoadFailed: "Die Ansicht konnte nicht geladen werden.",
  chartTruncated: "Nur ein Teil der Daten wird angezeigt.",
  chartLoadFailed: "Das Diagramm konnte nicht geladen werden."
};
