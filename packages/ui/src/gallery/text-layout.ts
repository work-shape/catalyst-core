/** The gallery's text for the navigation, page structure and data groups. */
export interface LayoutGalleryText {
  navMain: string;
  navWorkspace: string;
  navAccount: string;
  navCollapse: string;
  navExpand: string;
  navOpenDrawer: string;
  navDrawerHint: string;
  navNewChat: string;
  navChat: string;
  navApps: string;
  navWorkflows: string;
  navScheduled: string;
  navInbox: string;
  navBuild: string;
  navRecent: string;
  navConversationLease: string;
  navConversationTax: string;
  navConversationOffer: string;
  navItemStates: string;
  navItemLink: string;
  navGroupPlain: string;
  navGroupFolding: string;
  navGroupPinned: string;
  subRailRoutes: string;
  subRailAnchors: string;
  subRailSettings: string;
  subRailSections: string;
  subRailScope: string;
  subRailYou: string;
  subRailWorkspace: string;
  subRailProfile: string;
  subRailSecurity: string;
  subRailGeneral: string;
  subRailMembers: string;
  subRailDefaults: string;
  subRailOpenPage: string;
  sectionOverview: string;
  sectionOverviewDescription: string;
  sectionInstructions: string;
  sectionInstructionsDescription: string;
  sectionSkills: string;
  sectionSkillsDescription: string;
  sectionHistory: string;
  sectionHistoryDescription: string;
  sectionBody: string;
  tabsLabel: string;
  tabsGeneral: string;
  tabsMembers: string;
  tabsRequests: string;
  tabsAudit: string;
  tabsGeneralBody: string;
  tabsMembersBody: string;
  tabsRequestsBody: string;
  tabsViews: string;
  tabsRoutes: string;
  segmentLabel: string;
  segmentUsers: string;
  segmentPermissions: string;
  segmentPreviewLabel: string;
  segmentPreview: string;
  segmentFiles: string;
  segmentPolicyLabel: string;
  segmentAllow: string;
  segmentAsk: string;
  segmentNever: string;
  pageWidthNarrow: string;
  pageWidthDefault: string;
  pageWidthWide: string;
  headerListTitle: string;
  headerListDescription: string;
  headerNewAgent: string;
  headerBack: string;
  headerBreadcrumbBuild: string;
  headerBreadcrumbAgents: string;
  headerScope: string;
  headerTestRun: string;
  headerIdentifier: string;
  headerList: string;
  headerDetail: string;
  headerDetailBreadcrumb: string;
  disclosureAdvanced: string;
  disclosureAdvancedBody: string;
  disclosureErrors: string;
  disclosureErrorOne: string;
  disclosureErrorTwo: string;
  saveChanges: string;
  saveSaved: string;
  saveHint: string;
  saveDiscard: string;
  saveInline: string;
  saveSticky: string;
  surfaceBeside: string;
  surfaceFullscreen: string;
  surfaceCovering: string;
  surfaceTitle: string;
  surfaceSubtitle: string;
  surfaceBody: string;
  surfaceDownload: string;
  surfaceShowChat: string;
  surfaceViewFullscreen: string;
  surfaceExitFullscreen: string;
  surfaceClose: string;
  surfaceNoRenderer: string;
  saveStickyBody: string;
  rowAgentStatus: string;
  rowWorkflowStatus: string;
  rowKnowledgeStatus: string;
  rowPerson: string;
  rowPersonStatus: string;
  rowScopeInstance: string;
  rowModeLink: string;
  rowModeButton: string;
  rowModeExpandable: string;
  rowModeRequest: string;
  rowRequest: string;
  rowRequestBy: string;
  rowRequestState: string;
  rowModeCompact: string;
  rowModeDefault: string;
  rowExpandedBody: string;
  rowListLabel: string;
  filterStatus: string;
  filterAllStatuses: string;
  filterResults: string;
  filterNoResults: string;
  filterEmpty: string;
  filterClear: string;
  paginationRange: string;
  paginationRows: string;
  paginationRowsPerPage: string;
  paginationPrevious: string;
  paginationNext: string;
  tableOwner: string;
  keyUserId: string;
  keyUserIdValue: string;
  keyCreated: string;
  keyCreatedValue: string;
  keyLastActive: string;
  keyPrompt: string;
  keyPromptValue: string;
  keyInline: string;
  keyStacked: string;
  countPrimary: string;
  countMuted: string;
  countDot: string;
}

export const layoutGalleryText: Record<"en" | "de", LayoutGalleryText> = {
  en: {
    navMain: "Main navigation",
    navWorkspace: "Product team",
    navAccount: "Alex Morgan",
    navCollapse: "Collapse sidebar",
    navExpand: "Expand sidebar",
    navOpenDrawer: "Open navigation",
    navDrawerHint: "Below 768 px the sidebar opens over the page.",
    navNewChat: "New chat",
    navChat: "Chat",
    navApps: "Apps",
    navWorkflows: "Workflows",
    navScheduled: "Scheduled",
    navInbox: "Inbox",
    navBuild: "Build",
    navRecent: "Recent",
    navConversationLease: "Check the lease",
    navConversationTax: "Tax: depreciation over the remaining useful life",
    navConversationOffer: "Draft an offer",
    navItemStates: "States",
    navItemLink: "As a link",
    navGroupPlain: "Group label",
    navGroupFolding: "Group that folds",
    navGroupPinned: "Label that stays while its items scroll",
    subRailRoutes: "Routes",
    subRailAnchors: "Anchors",
    subRailSettings: "Settings pages",
    subRailSections: "Sections of this page",
    subRailScope: "Workspace",
    subRailYou: "You",
    subRailWorkspace: "Workspace",
    subRailProfile: "Profile",
    subRailSecurity: "Security",
    subRailGeneral: "General",
    subRailMembers: "Members",
    subRailDefaults: "Defaults",
    subRailOpenPage: "Open page",
    sectionOverview: "Overview",
    sectionOverviewDescription: "The name and what the agent is for.",
    sectionInstructions: "Instructions",
    sectionInstructionsDescription: "What the agent does and how it answers.",
    sectionSkills: "Skills",
    sectionSkillsDescription: "Skills the agent can read when a task needs them.",
    sectionHistory: "History",
    sectionHistoryDescription: "Every published revision of this agent.",
    sectionBody: "Each section is flat. A hairline separates it from the next one.",
    tabsLabel: "Views of the workspace",
    tabsGeneral: "General",
    tabsMembers: "Members",
    tabsRequests: "Requests",
    tabsAudit: "Audit",
    tabsGeneralBody: "Name, description and appearance of the workspace.",
    tabsMembersBody: "Twelve people work in this workspace.",
    tabsRequestsBody: "Three people asked to join.",
    tabsViews: "Views, switched in place",
    tabsRoutes: "Routes, as supplied links",
    segmentLabel: "List view",
    segmentUsers: "Users",
    segmentPermissions: "Permissions",
    segmentPreviewLabel: "Surface",
    segmentPreview: "Preview",
    segmentFiles: "Files",
    segmentPolicyLabel: "Policy",
    segmentAllow: "Allow",
    segmentAsk: "Ask me",
    segmentNever: "Never",
    pageWidthNarrow: "Narrow, for a form: 44rem",
    pageWidthDefault: "Default, for a list: 64rem",
    pageWidthWide: "Wide: all the room",
    headerListTitle: "Agents",
    headerListDescription: "Twelve agents, nine of them published.",
    headerNewAgent: "New agent",
    headerBack: "Back to agents",
    headerBreadcrumbBuild: "Build",
    headerBreadcrumbAgents: "Agents",
    headerScope: "Instance",
    headerTestRun: "Test run",
    headerIdentifier: "support-assistant",
    headerList: "List",
    headerDetail: "Detail, sticky",
    headerDetailBreadcrumb: "Detail with a breadcrumb",
    disclosureAdvanced: "Advanced",
    disclosureAdvancedBody: "The agent stops after twenty steps.",
    disclosureErrors: "Two build errors",
    disclosureErrorOne: "The file index.html is missing.",
    disclosureErrorTwo: "The script has a syntax error in line 12.",
    saveChanges: "Save changes",
    saveSaved: "Changes saved",
    saveHint: "Changes apply to new conversations at once.",
    saveDiscard: "Discard changes",
    saveInline: "Inline",
    saveSticky: "Sticky, with a second action",
    surfaceBeside: "Beside the conversation",
    surfaceFullscreen: "Fullscreen",
    surfaceCovering: "Covering the main area",
    surfaceTitle: "Quarterly report.pdf",
    surfaceSubtitle: "PDF, 4 pages",
    surfaceBody: "The surface's content scrolls under its header.",
    surfaceDownload: "Download",
    surfaceShowChat: "Show chat",
    surfaceViewFullscreen: "View fullscreen",
    surfaceExitFullscreen: "Exit fullscreen",
    surfaceClose: "Close",
    surfaceNoRenderer: "This content cannot be shown yet.",
    saveStickyBody: "Scroll this form: the bar stays at its bottom edge.",
    rowAgentStatus: "Published. Used in 48 conversations this week.",
    rowWorkflowStatus: "Running. Next start tomorrow at 08:00.",
    rowKnowledgeStatus: "Draft. 214 documents.",
    rowPerson: "Alex Morgan",
    rowPersonStatus: "Administrator. Last active today.",
    rowScopeInstance: "Instance",
    rowModeLink: "As a link",
    rowModeButton: "As a button, selectable",
    rowModeExpandable: "Expandable",
    rowModeRequest: "With a person in the status line",
    rowRequest: "Add the notice periods to the tenancy rules",
    rowRequestBy: "Alex Morgan, via Support assistant",
    rowRequestState: "Waiting",
    rowModeCompact: "Compact, 36 px",
    rowModeDefault: "Default, 44 px",
    rowExpandedBody: "The last run checked 31 invoices and flagged two.",
    rowListLabel: "Assets",
    filterStatus: "Status",
    filterAllStatuses: "All statuses",
    filterResults: "3 results",
    filterNoResults: "0 results",
    filterEmpty: "No agent matches these filters.",
    filterClear: "Clear filters",
    paginationRange: "{from}-{to} of 42",
    paginationRows: "Rows",
    paginationRowsPerPage: "Rows per page",
    paginationPrevious: "Previous page",
    paginationNext: "Next page",
    tableOwner: "Owner",
    keyUserId: "User ID",
    keyUserIdValue: "usr_01HZX4M7Q2K9",
    keyCreated: "Created",
    keyCreatedValue: "3 March, 09:41",
    keyLastActive: "Last active",
    keyPrompt: "Request",
    keyPromptValue:
      "Compare the three offers for the roof renovation, list what each one leaves out, and say which one you would take and why. Keep the answer short enough to read on a phone, name the page of each offer you quote from, and flag every price that is not fixed. If an offer misses the scaffolding, say so first.",
    keyInline: "Inline",
    keyStacked: "Stacked",
    countPrimary: "Needs you",
    countMuted: "Plain count",
    countDot: "Dot"
  },
  de: {
    navMain: "Hauptnavigation",
    navWorkspace: "Produktteam",
    navAccount: "Alex Morgan",
    navCollapse: "Seitenleiste einklappen",
    navExpand: "Seitenleiste ausklappen",
    navOpenDrawer: "Navigation öffnen",
    navDrawerHint: "Unter 768 px öffnet sich die Seitenleiste als Überlagerung.",
    navNewChat: "Neuer Chat",
    navChat: "Chat",
    navApps: "Apps",
    navWorkflows: "Workflows",
    navScheduled: "Geplant",
    navInbox: "Eingang",
    navBuild: "Bauen",
    navRecent: "Zuletzt",
    navConversationLease: "Mietvertrag prüfen",
    navConversationTax: "Steuer: Abschreibung über die restliche Nutzungsdauer",
    navConversationOffer: "Angebot entwerfen",
    navItemStates: "Zustände",
    navItemLink: "Als Link",
    navGroupPlain: "Gruppenbezeichnung",
    navGroupFolding: "Einklappbare Gruppe",
    navGroupPinned: "Bezeichnung bleibt stehen, während die Einträge rollen",
    subRailRoutes: "Seiten",
    subRailAnchors: "Anker",
    subRailSettings: "Einstellungsseiten",
    subRailSections: "Abschnitte dieser Seite",
    subRailScope: "Arbeitsbereich",
    subRailYou: "Du",
    subRailWorkspace: "Arbeitsbereich",
    subRailProfile: "Profil",
    subRailSecurity: "Sicherheit",
    subRailGeneral: "Allgemein",
    subRailMembers: "Mitglieder",
    subRailDefaults: "Standards",
    subRailOpenPage: "Geöffnete Seite",
    sectionOverview: "Überblick",
    sectionOverviewDescription: "Der Name und wofür der Agent da ist.",
    sectionInstructions: "Anweisungen",
    sectionInstructionsDescription: "Was der Agent tut und wie er antwortet.",
    sectionSkills: "Skills",
    sectionSkillsDescription: "Skills, die der Agent liest, wenn eine Aufgabe sie braucht.",
    sectionHistory: "Verlauf",
    sectionHistoryDescription: "Jede veröffentlichte Revision dieses Agenten.",
    sectionBody: "Jeder Abschnitt ist flach. Eine Haarlinie trennt ihn vom nächsten.",
    tabsLabel: "Ansichten des Arbeitsbereichs",
    tabsGeneral: "Allgemein",
    tabsMembers: "Mitglieder",
    tabsRequests: "Anfragen",
    tabsAudit: "Audit",
    tabsGeneralBody: "Name, Beschreibung und Darstellung des Arbeitsbereichs.",
    tabsMembersBody: "Zwölf Personen arbeiten in diesem Arbeitsbereich.",
    tabsRequestsBody: "Drei Personen möchten beitreten.",
    tabsViews: "Ansichten, an Ort und Stelle gewechselt",
    tabsRoutes: "Seiten, als übergebene Links",
    segmentLabel: "Listenansicht",
    segmentUsers: "Benutzer",
    segmentPermissions: "Berechtigungen",
    segmentPreviewLabel: "Fläche",
    segmentPreview: "Vorschau",
    segmentFiles: "Dateien",
    segmentPolicyLabel: "Richtlinie",
    segmentAllow: "Erlauben",
    segmentAsk: "Frag mich",
    segmentNever: "Nie",
    pageWidthNarrow: "Schmal, für ein Formular: 44rem",
    pageWidthDefault: "Standard, für eine Liste: 64rem",
    pageWidthWide: "Breit: der ganze Platz",
    headerListTitle: "Agenten",
    headerListDescription: "Zwölf Agenten, neun davon veröffentlicht.",
    headerNewAgent: "Neuer Agent",
    headerBack: "Zurück zu den Agenten",
    headerBreadcrumbBuild: "Bauen",
    headerBreadcrumbAgents: "Agenten",
    headerScope: "Instanz",
    headerTestRun: "Testlauf",
    headerIdentifier: "support-assistent",
    headerList: "Liste",
    headerDetail: "Detail, haftend",
    headerDetailBreadcrumb: "Detail mit Brotkrumen",
    disclosureAdvanced: "Erweitert",
    disclosureAdvancedBody: "Der Agent hält nach zwanzig Schritten an.",
    disclosureErrors: "Zwei Build-Fehler",
    disclosureErrorOne: "Die Datei index.html fehlt.",
    disclosureErrorTwo: "Das Skript hat einen Syntaxfehler in Zeile 12.",
    saveChanges: "Änderungen speichern",
    saveSaved: "Änderungen gespeichert",
    saveHint: "Änderungen gelten sofort für neue Unterhaltungen.",
    saveDiscard: "Änderungen verwerfen",
    saveInline: "Im Fluss",
    saveSticky: "Haftend, mit zweiter Aktion",
    surfaceBeside: "Neben der Unterhaltung",
    surfaceFullscreen: "Vollbild",
    surfaceCovering: "Über dem Hauptbereich",
    surfaceTitle: "Quartalsbericht.pdf",
    surfaceSubtitle: "PDF, 4 Seiten",
    surfaceBody: "Der Inhalt der Fläche scrollt unter ihrer Kopfzeile.",
    surfaceDownload: "Herunterladen",
    surfaceShowChat: "Chat anzeigen",
    surfaceViewFullscreen: "Im Vollbild anzeigen",
    surfaceExitFullscreen: "Vollbild schließen",
    surfaceClose: "Schließen",
    surfaceNoRenderer: "Dieser Inhalt kann noch nicht angezeigt werden.",
    saveStickyBody: "Scrolle dieses Formular: Die Leiste bleibt am unteren Rand.",
    rowAgentStatus: "Veröffentlicht. Diese Woche in 48 Unterhaltungen genutzt.",
    rowWorkflowStatus: "Läuft. Nächster Start morgen um 08:00.",
    rowKnowledgeStatus: "Entwurf. 214 Dokumente.",
    rowPerson: "Alex Morgan",
    rowPersonStatus: "Administrator. Heute zuletzt aktiv.",
    rowScopeInstance: "Instanz",
    rowModeLink: "Als Link",
    rowModeButton: "Als Schaltfläche, auswählbar",
    rowModeExpandable: "Aufklappbar",
    rowModeRequest: "Mit einer Person in der Statuszeile",
    rowRequest: "Kündigungsfristen in die Mietregeln aufnehmen",
    rowRequestBy: "Alex Morgan, über Support-Assistent",
    rowRequestState: "Wartet",
    rowModeCompact: "Kompakt, 36 px",
    rowModeDefault: "Standard, 44 px",
    rowExpandedBody: "Der letzte Lauf hat 31 Rechnungen geprüft und zwei markiert.",
    rowListLabel: "Assets",
    filterStatus: "Status",
    filterAllStatuses: "Alle Status",
    filterResults: "3 Ergebnisse",
    filterNoResults: "0 Ergebnisse",
    filterEmpty: "Kein Agent passt zu diesen Filtern.",
    filterClear: "Filter zurücksetzen",
    paginationRange: "{from}–{to} von 42",
    paginationRows: "Zeilen",
    paginationRowsPerPage: "Zeilen pro Seite",
    paginationPrevious: "Vorherige Seite",
    paginationNext: "Nächste Seite",
    tableOwner: "Verantwortlich",
    keyUserId: "Benutzer-ID",
    keyUserIdValue: "usr_01HZX4M7Q2K9",
    keyCreated: "Erstellt",
    keyCreatedValue: "3. März, 09:41",
    keyLastActive: "Zuletzt aktiv",
    keyPrompt: "Anfrage",
    keyPromptValue:
      "Vergleiche die drei Angebote für die Dachsanierung, liste auf, was jedes auslässt, und sag, welches du nehmen würdest und warum. Halte die Antwort so kurz, dass sie auf einem Telefon lesbar ist, nenne die Seite jedes Angebots, aus dem du zitierst, und markiere jeden Preis, der nicht fest ist. Wenn einem Angebot das Gerüst fehlt, sag das zuerst.",
    keyInline: "Nebeneinander",
    keyStacked: "Gestapelt",
    countPrimary: "Braucht dich",
    countMuted: "Einfache Anzahl",
    countDot: "Punkt"
  }
};
