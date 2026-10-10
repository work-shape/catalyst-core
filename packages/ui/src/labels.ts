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
  /** Under a chart that drew only the first rows or series of its data. */
  chartTruncated: string;
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
  chartTruncated: "Only part of the data is shown."
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
  chartTruncated: "Nur ein Teil der Daten wird angezeigt."
};
