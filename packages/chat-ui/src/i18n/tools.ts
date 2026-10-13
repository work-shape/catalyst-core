import { defineTranslations } from "./translation-area";

export const tools = defineTranslations({
  en: {
    closeDisplayPanel: "Close display panel",
    collapseDisplay: "Collapse display",
    displayLoading: "Loading view…",
    displayScriptBlocked: "Part of this view could not load.",
    displayPanelFallbackTitle: "Display",
    openDisplayPanel: "Open in side panel",
    expandDisplay: "Expand display",
    shownInSidePanel: "Shown in side panel",
    resizeDisplayPanel: "Resize display panel",
    structuredOutput: "Structured output: {name}",
    toolCompleted: "Completed",
    toolConnectionChangeFailed: "Could not change {name}",
    toolConnectionChanged: "Changed {name}",
    toolConnectionChanging: "Changing {name}",
    toolConnectionRead: "Read {name}",
    toolConnectionReadFailed: "Could not read {name}",
    toolConnectionReading: "Reading {name}",
    toolConnectionUseFailed: "Could not use {name}",
    toolConnectionUsed: "Used {name}",
    toolConnectionUsing: "Using {name}",
    toolDetails: "Technical details",
    toolFailed: "Failed",
    toolInput: "Input",
    toolOutput: "Output",
    toolRunning: "Running",
    toolTechnicalName: "Tool",
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
    displayScriptBlocked: "Ein Teil dieser Ansicht konnte nicht geladen werden.",
    displayPanelFallbackTitle: "Ansicht",
    openDisplayPanel: "In Seitenansicht öffnen",
    expandDisplay: "Ansicht ausklappen",
    shownInSidePanel: "In Seitenansicht geöffnet",
    resizeDisplayPanel: "Breite der Seitenansicht anpassen",
    structuredOutput: "Strukturierte Ausgabe: {name}",
    toolCompleted: "Abgeschlossen",
    toolConnectionChangeFailed: "{name} konnte nicht geändert werden",
    toolConnectionChanged: "{name} geändert",
    toolConnectionChanging: "Ändert {name}",
    toolConnectionRead: "{name} gelesen",
    toolConnectionReadFailed: "{name} konnte nicht gelesen werden",
    toolConnectionReading: "Liest {name}",
    toolConnectionUseFailed: "{name} konnte nicht verwendet werden",
    toolConnectionUsed: "{name} verwendet",
    toolConnectionUsing: "Verwendet {name}",
    toolDetails: "Technische Details",
    toolFailed: "Fehlgeschlagen",
    toolInput: "Eingabe",
    toolOutput: "Ausgabe",
    toolRunning: "Läuft",
    toolTechnicalName: "Werkzeug",
    workspaceCommandCancelled:
      "Der Workspace-Schritt wurde abgebrochen, bevor er abgeschlossen war.",
    workspaceCommandFailed:
      "Der Workspace-Schritt wurde nicht erfolgreich abgeschlossen. Der Agent kann den Dateischritt anpassen und erneut versuchen.",
    workspaceCommandTimedOut:
      "Der Workspace-Schritt hat das Zeitlimit erreicht. Der Agent kann es mit einem kleineren oder einfacheren Schritt erneut versuchen."
  }
});
