/** The gallery's text for the canvas entries and the side panel. */
export interface FlowGalleryText {
  groupFlow: string;
  flowLinear: string;
  flowRun: string;
  flowLarge: string;
  flowFailed: string;
  flowWaiting: string;
  flowStates: string;
  flowPhone: string;
  flowCanvasLabel: string;
  flowEmptyLabel: string;
  flowSearch: string;
  flowNodeStatuses: string;
  flowNodeParts: string;
  flowNodeCompact: string;
  flowGroupStates: string;
  flowEdgeStates: string;
  flowHandleStates: string;
  iconsGeneric: string;
  iconsFallback: string;
  iconsFamilies: string;
  iconsFileTypes: string;
  iconsFileSizes: string;
  flowControlsFull: string;
  flowControlsNarrow: string;
  flowMinimapSample: string;
  flowKindStart: string;
  flowKindRead: string;
  flowKindWrite: string;
  flowKindLoop: string;
  flowKindScript: string;
  flowKindAgent: string;
  flowKindApproval: string;
  flowKindSubflow: string;
  flowKindCondition: string;
  flowKindParallel: string;
  flowKindResult: string;
  flowTriggerTitle: string;
  flowTriggerShort: string;
  flowTriggerSummary: string;
  flowTriggerRun: string;
  flowTriggerRunFooter: string;
  flowLoadTitle: string;
  flowLoadSummary: string;
  flowLoadFooter: string;
  flowLoadFailure: string;
  flowLoopTitle: string;
  flowLoopSummary: string;
  flowLoopCounts: string;
  flowLoopNote: string;
  flowLoopAction: string;
  flowLoopDone: string;
  flowBookingsTitle: string;
  flowBookingsSummary: string;
  flowBookingsFooter: string;
  flowCheckTitle: string;
  flowCheckSummary: string;
  flowCheckFooter: string;
  flowSaveTitle: string;
  flowSaveSummary: string;
  flowSaveFooter: string;
  flowAgentTitle: string;
  flowAgentSummary: string;
  flowResultTitle: string;
  flowResultShort: string;
  flowConditionTitle: string;
  flowExitYes: string;
  flowExitOtherwise: string;
  flowParallelTitle: string;
  flowDashboardTitle: string;
  flowApprovalTitle: string;
  flowApprovalFooter: string;
  flowSubflowTitle: string;
  flowOpen: string;
  flowChipBookings: string;
  flowChipFindings: string;
  flowDurationShort: string;
  flowDurationLong: string;
  flowSelected: string;
  flowCollapsed: string;
  flowStatusIdle: string;
  sidePanelFloat: string;
  sidePanelSheet: string;
  sidePanelTabs: string;
  sidePanelTabWhat: string;
  sidePanelTabInput: string;
  sidePanelTabOutput: string;
  sidePanelTabEntries: string;
  sidePanelTook: string;
  sidePanelReadFrom: string;
  sidePanelPassesOn: string;
  sidePanelPassesOnValue: string;
  sidePanelBody: string;
  sidePanelOpen: string;
}

export const flowGalleryText: Record<"en" | "de", FlowGalleryText> = {
  en: {
    groupFlow: "Canvas",
    flowLinear: "A linear graph that is only described, with a loop as a group",
    flowRun: "Something that runs: statuses, counts, a selected node and its panel",
    flowLarge: "A large graph: a condition, a parallel block, a loop and a subflow",
    flowFailed: "A failed node with its reason; what follows was not reached",
    flowWaiting: "Waiting on a person, with a folded group",
    flowStates: "Empty and loading",
    flowPhone: "At 390 px: top to bottom, the panel as a sheet",
    flowCanvasLabel: "Monthly booking check",
    flowEmptyLabel: "This workflow has no steps yet.",
    flowSearch: "Find a step",
    flowNodeStatuses: "Every status: idle, running, waiting, done, failed, skipped",
    flowNodeParts: "Selected, with rows that each have an exit, stacked, with an accent tile",
    flowNodeCompact: "Compact, as below 60 % zoom",
    flowGroupStates: "Open with progress, selected, folded, done",
    flowEdgeStates: "Rest, done, active, skipped",
    flowHandleStates: "Handles take the state of their edge",
    iconsFamilies: "A key nobody registered shows the generic icon of its family",
    iconsGeneric: "The generic icons",
    iconsFileTypes: "The file types, and the neutral page for a type without an icon",
    iconsFileSizes: "As large as in a chip, in a list row and on a starter",
    iconsFallback: "An unknown key shows its fallback, a registered one its own icon",
    flowControlsFull: "With the search field and tidy",
    flowControlsNarrow: "Under 600 px: zoom and fit",
    flowMinimapSample: "The whole graph with the visible part marked",
    flowKindStart: "Starts",
    flowKindRead: "Reads data",
    flowKindWrite: "Changes data",
    flowKindLoop: "Loop",
    flowKindScript: "Script",
    flowKindAgent: "AI agent",
    flowKindApproval: "Waits for approval",
    flowKindSubflow: "Workflow",
    flowKindCondition: "If",
    flowKindParallel: "Parallel",
    flowKindResult: "Result",
    flowTriggerTitle: "Every month on the 1st, 06:00",
    flowTriggerShort: "Every month",
    flowTriggerSummary: "Or when someone starts it.",
    flowTriggerRun: "Started by Jana Petersen",
    flowTriggerRunFooter: "Today, 7:07 PM",
    flowLoadTitle: "Load the clients",
    flowLoadSummary: "Fetches the list of every active client.",
    flowLoadFooter: "600 clients",
    flowLoadFailure: "The Bookings connection refused the sign-in.",
    flowLoopTitle: "For each client",
    flowLoopSummary: "About 600 clients, 8 at a time.",
    flowLoopCounts: "212 of 600",
    flowLoopNote: "13 min so far · 209 done · 3 failed · 8 running · 380 to go",
    flowLoopAction: "Show the 3 failed",
    flowLoopDone: "600 of 600",
    flowBookingsTitle: "Load the bookings",
    flowBookingsSummary: "Fetches the bookings of the month before.",
    flowBookingsFooter: "215 done · 2 failed · 3 running",
    flowCheckTitle: "Check the bookings",
    flowCheckSummary: "Checks every booking against twelve rules.",
    flowCheckFooter: "211 done · 1 failed · 3 running",
    flowSaveTitle: "Save the findings",
    flowSaveSummary: "Writes what stands out.",
    flowSaveFooter: "209 done · 2 running",
    flowAgentTitle: "Write the summary",
    flowAgentSummary: "Sums up the findings for the tax team.",
    flowResultTitle: "Clients checked and findings",
    flowResultShort: "Result",
    flowConditionTitle: "Anything found?",
    flowExitYes: "Yes",
    flowExitOtherwise: "Otherwise",
    flowParallelTitle: "At the same time",
    flowDashboardTitle: "Update the dashboard",
    flowApprovalTitle: "Tax lead confirms",
    flowApprovalFooter: "Waiting for Miriam Voss since 7:48 PM",
    flowSubflowTitle: "Notify clients",
    flowOpen: "Open",
    flowChipBookings: "Bookings",
    flowChipFindings: "Findings",
    flowDurationShort: "4 sec",
    flowDurationLong: "12 sec",
    flowSelected: "Selected",
    flowCollapsed: "Folded",
    flowStatusIdle: "Idle",
    sidePanelFloat: "Floating over the right edge of its container",
    sidePanelSheet: "As a sheet from the bottom, as under 600 px",
    sidePanelTabs: "Views of the step",
    sidePanelTabWhat: "What it does",
    sidePanelTabInput: "Input",
    sidePanelTabOutput: "Output",
    sidePanelTabEntries: "Entries",
    sidePanelTook: "Took",
    sidePanelReadFrom: "Read from",
    sidePanelPassesOn: "Passes on",
    sidePanelPassesOnValue: "600 clients to “For each client”",
    sidePanelBody:
      "The panel leaves the rest of its container in use: it holds no focus and dims nothing.",
    sidePanelOpen: "Open the panel"
  },
  de: {
    groupFlow: "Canvas",
    flowLinear: "Ein linearer Graph, nur beschrieben, mit einer Schleife als Gruppe",
    flowRun: "Etwas, das läuft: Status, Zähler, ein ausgewählter Knoten und sein Panel",
    flowLarge: "Ein großer Graph: Bedingung, paralleler Block, Schleife und Unterablauf",
    flowFailed: "Ein fehlgeschlagener Knoten mit Grund; was folgt, wurde nicht erreicht",
    flowWaiting: "Wartet auf eine Person, mit einer zugeklappten Gruppe",
    flowStates: "Leer und beim Laden",
    flowPhone: "Bei 390 px: von oben nach unten, das Panel als Blatt",
    flowCanvasLabel: "Monatliche Buchungsprüfung",
    flowEmptyLabel: "Dieser Workflow hat noch keine Schritte.",
    flowSearch: "Schritt suchen",
    flowNodeStatuses: "Jeder Status: ruhend, läuft, wartet, fertig, fehlgeschlagen, übersprungen",
    flowNodeParts: "Ausgewählt, mit Zeilen mit je einem Ausgang, gestapelt, mit Akzentkachel",
    flowNodeCompact: "Kompakt, wie unter 60 % Zoom",
    flowGroupStates: "Offen mit Fortschritt, ausgewählt, zugeklappt, fertig",
    flowEdgeStates: "Ruhend, fertig, aktiv, übersprungen",
    flowHandleStates: "Anschlüsse übernehmen den Zustand ihrer Kante",
    iconsFamilies:
      "Ein Schlüssel, den niemand registriert hat, zeigt das generische Symbol seiner Familie",
    iconsGeneric: "Die generischen Symbole",
    iconsFileTypes: "Die Dateitypen und die neutrale Seite für einen Typ ohne eigenes Symbol",
    iconsFileSizes: "So groß wie in einem Chip, in einer Listenzeile und auf einem Einstieg",
    iconsFallback:
      "Ein unbekannter Schlüssel zeigt seinen Ersatz, ein registrierter sein eigenes Symbol",
    flowControlsFull: "Mit Suchfeld und Aufräumen",
    flowControlsNarrow: "Unter 600 px: Zoom und Einpassen",
    flowMinimapSample: "Der ganze Graph mit markiertem sichtbarem Teil",
    flowKindStart: "Start",
    flowKindRead: "Liest Daten",
    flowKindWrite: "Ändert Daten",
    flowKindLoop: "Schleife",
    flowKindScript: "Skript",
    flowKindAgent: "KI-Agent",
    flowKindApproval: "Wartet auf Freigabe",
    flowKindSubflow: "Workflow",
    flowKindCondition: "Wenn",
    flowKindParallel: "Parallel",
    flowKindResult: "Ergebnis",
    flowTriggerTitle: "Jeden Monat am 1., 06:00",
    flowTriggerShort: "Jeden Monat",
    flowTriggerSummary: "Oder wenn jemand ihn startet.",
    flowTriggerRun: "Von Jana Petersen gestartet",
    flowTriggerRunFooter: "Heute, 19:07",
    flowLoadTitle: "Mandanten laden",
    flowLoadSummary: "Holt die Liste aller aktiven Mandanten.",
    flowLoadFooter: "600 Mandanten",
    flowLoadFailure: "Die Verbindung Buchungen hat die Anmeldung abgelehnt.",
    flowLoopTitle: "Für jeden Mandanten",
    flowLoopSummary: "Etwa 600 Mandanten, 8 gleichzeitig.",
    flowLoopCounts: "212 von 600",
    flowLoopNote: "bisher 13 Min. · 209 fertig · 3 fehlgeschlagen · 8 laufen · 380 offen",
    flowLoopAction: "Die 3 fehlgeschlagenen zeigen",
    flowLoopDone: "600 von 600",
    flowBookingsTitle: "Buchungen laden",
    flowBookingsSummary: "Holt die Buchungen des Vormonats.",
    flowBookingsFooter: "215 fertig · 2 fehlgeschlagen · 3 laufen",
    flowCheckTitle: "Buchungen prüfen",
    flowCheckSummary: "Prüft jede Buchung gegen zwölf Regeln.",
    flowCheckFooter: "211 fertig · 1 fehlgeschlagen · 3 laufen",
    flowSaveTitle: "Auffälligkeiten speichern",
    flowSaveSummary: "Schreibt, was auffällt.",
    flowSaveFooter: "209 fertig · 2 laufen",
    flowAgentTitle: "Zusammenfassung schreiben",
    flowAgentSummary: "Fasst die Auffälligkeiten für das Steuerteam zusammen.",
    flowResultTitle: "Geprüfte Mandanten und Auffälligkeiten",
    flowResultShort: "Ergebnis",
    flowConditionTitle: "Etwas gefunden?",
    flowExitYes: "Ja",
    flowExitOtherwise: "Sonst",
    flowParallelTitle: "Gleichzeitig",
    flowDashboardTitle: "Dashboard aktualisieren",
    flowApprovalTitle: "Steuerleitung bestätigt",
    flowApprovalFooter: "Wartet seit 19:48 auf Miriam Voss",
    flowSubflowTitle: "Mandanten benachrichtigen",
    flowOpen: "Öffnen",
    flowChipBookings: "Buchungen",
    flowChipFindings: "Auffälligkeiten",
    flowDurationShort: "4 Sek.",
    flowDurationLong: "12 Sek.",
    flowSelected: "Ausgewählt",
    flowCollapsed: "Zugeklappt",
    flowStatusIdle: "Ruhend",
    sidePanelFloat: "Schwebend über dem rechten Rand seines Containers",
    sidePanelSheet: "Als Blatt von unten, wie unter 600 px",
    sidePanelTabs: "Ansichten des Schritts",
    sidePanelTabWhat: "Was er tut",
    sidePanelTabInput: "Eingabe",
    sidePanelTabOutput: "Ausgabe",
    sidePanelTabEntries: "Einträge",
    sidePanelTook: "Dauer",
    sidePanelReadFrom: "Gelesen aus",
    sidePanelPassesOn: "Gibt weiter",
    sidePanelPassesOnValue: "600 Mandanten an „Für jeden Mandanten“",
    sidePanelBody:
      "Das Panel lässt den Rest seines Containers benutzbar: Es hält keinen Fokus und dunkelt nichts ab.",
    sidePanelOpen: "Panel öffnen"
  }
};
