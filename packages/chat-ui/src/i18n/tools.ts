import { defineTranslations } from "./translation-area";

export const tools = defineTranslations({
  en: {
    closeDisplayPanel: "Close display panel",
    collapseDisplay: "Collapse display",
    displayLoading: "Loading view…",
    displayPanelFallbackTitle: "Display",
    openDisplayPanel: "Open in side panel",
    expandDisplay: "Expand display",
    shownInSidePanel: "Shown in side panel",
    resizeDisplayPanel: "Resize display panel",
    structuredOutput: "Structured output: {name}",
    toolCompleted: "Completed",
    toolDetails: "Details",
    toolFailed: "Failed",
    toolInput: "Input",
    toolOutput: "Output",
    toolRunning: "Running",
    workspaceCommandCancelled: "The workspace step was cancelled before it completed.",
    workspaceCommandFailed:
      "The workspace step did not finish successfully. The agent can adjust the file workflow and try again.",
    workspaceCommandTimedOut:
      "The workspace step timed out. The agent can retry with a smaller or simpler step."
  },
  de: {
    closeDisplayPanel: "Ansicht schließen",
    collapseDisplay: "Ansicht einklappen",
    displayLoading: "Ansicht wird geladen…",
    displayPanelFallbackTitle: "Ansicht",
    openDisplayPanel: "In Seitenansicht öffnen",
    expandDisplay: "Ansicht ausklappen",
    shownInSidePanel: "In Seitenansicht geöffnet",
    resizeDisplayPanel: "Breite der Seitenansicht anpassen",
    structuredOutput: "Strukturierte Ausgabe: {name}",
    toolCompleted: "Abgeschlossen",
    toolDetails: "Details",
    toolFailed: "Fehlgeschlagen",
    toolInput: "Eingabe",
    toolOutput: "Ausgabe",
    toolRunning: "Läuft",
    workspaceCommandCancelled:
      "Der Workspace-Schritt wurde abgebrochen, bevor er abgeschlossen war.",
    workspaceCommandFailed:
      "Der Workspace-Schritt wurde nicht erfolgreich abgeschlossen. Der Agent kann den Dateischritt anpassen und erneut versuchen.",
    workspaceCommandTimedOut:
      "Der Workspace-Schritt hat das Zeitlimit erreicht. Der Agent kann es mit einem kleineren oder einfacheren Schritt erneut versuchen."
  }
});
