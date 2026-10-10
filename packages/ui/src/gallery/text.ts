import { chartGalleryText, type ChartGalleryText } from "./text-chart";
import { layoutGalleryText, type LayoutGalleryText } from "./text-layout";
import { sampleGalleryText, type SampleGalleryText } from "./text-samples";

export type GalleryLanguage = "en" | "de";

/** Every text the gallery shows, in both interface languages. Component names are not translated. */
export interface GalleryText extends LayoutGalleryText, SampleGalleryText, ChartGalleryText {
  title: string;
  mode: string;
  modeLight: string;
  modeDark: string;
  modeBoth: string;
  language: string;
  groups: string;
  groupFoundations: string;
  groupActions: string;
  groupForms: string;
  groupOverlays: string;
  groupNavigation: string;
  groupStructure: string;
  groupData: string;
  groupStatus: string;
  groupFeedback: string;
  emptyGroup: string;
  colors: string;
  typeStyles: string;
  typeSample: string;
  radius: string;
  shadows: string;
  controlHeights: string;
  icons: string;
  focus: string;
  focusHint: string;
  save: string;
  cancel: string;
  delete: string;
  publish: string;
  learnMore: string;
  saving: string;
  disabled: string;
  settings: string;
  addItem: string;
  moreActions: string;
  name: string;
  namePlaceholder: string;
  searchPlaceholder: string;
  invalidValue: string;
  instructions: string;
  instructionsSample: string;
  codeSample: string;
  role: string;
  roleMember: string;
  roleAdmin: string;
  enabled: string;
  notifyByEmail: string;
  notifyByEmailHint: string;
  selectAll: string;
  acceptTerms: string;
  visibility: string;
  visibilityDiscoverable: string;
  visibilityDiscoverableHint: string;
  visibilityPrivate: string;
  visibilityPrivateHint: string;
  visibilityArchived: string;
  visibilityArchivedHint: string;
  visibilityHelp: string;
  availability: string;
  availabilityAll: string;
  availabilitySelected: string;
  nameHint: string;
  nameError: string;
  description: string;
  liveChanges: string;
  liveChangesHint: string;
  confirmDelete: string;
  confirmDeleteTitle: string;
  confirmDeleteBody: string;
  confirmPublish: string;
  confirmPublishTitle: string;
  confirmPublishBody: string;
  confirmWhileRunning: string;
  openPopover: string;
  popoverTitle: string;
  popoverBody: string;
  menuEdit: string;
  menuDuplicate: string;
  menuCopyLink: string;
  menuRunNow: string;
  menuRunNowReason: string;
  menuArchive: string;
  menuView: string;
  menuShowDrafts: string;
  menuShowArchived: string;
  pickAgent: string;
  paletteOpen: string;
  paletteLabel: string;
  paletteConversations: string;
  paletteNoMatch: string;
  navRowActions: string;
  navRowMore: string;
  skipLinkLabel: string;
  skipLinkHint: string;
  skipLinkTarget: string;
  pickWorkspaces: string;
  pickRole: string;
  pickerInDialog: string;
  pickerGroupWorkspace: string;
  pickerGroupInstance: string;
  agentSupportHint: string;
  agentSupportLongHint: string;
  /** Enough agents that their list scrolls, several of them under the same first letter. */
  manyAgents: readonly string[];
  agentResearch: string;
  agentResearchHint: string;
  agentContracts: string;
  agentContractsHint: string;
  agentPayroll: string;
  agentPayrollReason: string;
  createAgent: string;
  workspaceMarketing: string;
  workspaceFinance: string;
  workspaceLegal: string;
  instanceName: string;
  personName: string;
  groupEditors: string;
  readOnly: string;
  avatarPerson: string;
  avatarWorkspace: string;
  avatarAgent: string;
  avatarApp: string;
  bannerInfo: string;
  bannerSuccess: string;
  bannerWarningTitle: string;
  bannerWarning: string;
  bannerDanger: string;
  bannerAction: string;
  bannerPage: string;
  bannerLine: string;
  showAgain: string;
  noticeSaved: string;
  noticeFailed: string;
  emptyAgents: string;
  emptyAgentsAction: string;
  emptyPresetBriefing: string;
  emptyPresetReview: string;
  emptyPresetTriage: string;
  emptyInline: string;
  emptyNoRight: string;
  layoutPage: string;
  layoutInline: string;
  layoutNoRight: string;
  skeletonShapes: string;
  skeletonList: string;
  skeletonPage: string;
  openDialog: string;
  dialogTitle: string;
  dialogDescription: string;
  dialogBody: string;
  tooltipText: string;
  hoverCardTrigger: string;
  hoverCardBody: string;
  cardTitle: string;
  cardBody: string;
  tableName: string;
  tableState: string;
  tableUpdated: string;
  rowAgent: string;
  rowWorkflow: string;
  rowKnowledge: string;
  countPending: string;
  today: string;
  yesterday: string;
  stateDraft: string;
  stateRunning: string;
  statePublished: string;
  stateNeedsReconnect: string;
  stateFailed: string;
  stateNew: string;
  errorMessage: string;
}

export const galleryText: Record<GalleryLanguage, GalleryText> = {
  en: {
    title: "UI library",
    mode: "Mode",
    modeLight: "Light",
    modeDark: "Dark",
    modeBoth: "Both",
    language: "Language",
    groups: "Component groups",
    groupFoundations: "Foundations",
    groupActions: "Actions",
    groupForms: "Forms",
    groupOverlays: "Overlays",
    groupNavigation: "Navigation",
    groupStructure: "Page structure",
    groupData: "Data",
    groupStatus: "Status",
    groupFeedback: "Feedback",
    emptyGroup: "This group has no components yet.",
    colors: "Colours",
    typeStyles: "Type styles",
    typeSample: "The quick brown fox jumps over the lazy dog",
    radius: "Radius",
    shadows: "Shadows",
    controlHeights: "Control heights",
    icons: "Icons",
    focus: "Focus",
    focusHint: "Press Tab to move the focus line through these controls.",
    save: "Save",
    cancel: "Cancel",
    delete: "Delete",
    publish: "Publish",
    learnMore: "Learn more",
    saving: "Saving",
    disabled: "Disabled",
    settings: "Settings",
    addItem: "Add",
    moreActions: "More actions",
    name: "Name",
    namePlaceholder: "Support assistant",
    searchPlaceholder: "Search agents",
    invalidValue: "Not a valid name",
    instructions: "Instructions",
    instructionsSample: "Answer briefly and name your sources.",
    codeSample: "name: support-assistant\nmodel: default",
    role: "Role",
    roleMember: "Member",
    roleAdmin: "Administrator",
    enabled: "Enabled",
    notifyByEmail: "Notify me by email",
    notifyByEmailHint: "One message per finished run.",
    selectAll: "Select all",
    acceptTerms: "I have read the usage rules",
    visibility: "Visibility",
    visibilityDiscoverable: "Discoverable",
    visibilityDiscoverableHint: "Everyone in the organisation can find and join it.",
    visibilityPrivate: "Private",
    visibilityPrivateHint: "Only invited members see it.",
    visibilityArchived: "Archived",
    visibilityArchivedHint: "Not available in your plan.",
    visibilityHelp: "You can change this later in the workspace settings.",
    availability: "Available in",
    availabilityAll: "All workspaces",
    availabilitySelected: "Selected workspaces",
    nameHint: "Shown in the agent list and in every conversation.",
    nameError: "Enter a name with at least three characters.",
    description: "Description",
    liveChanges: "Live changes",
    liveChangesHint: "Actions in the draft change real data.",
    confirmDelete: "Delete agent",
    confirmDeleteTitle: "Delete Support assistant?",
    confirmDeleteBody:
      "The agent is removed for everyone in this workspace. This cannot be undone.",
    confirmPublish: "Publish changes",
    confirmPublishTitle: "Publish Support assistant?",
    confirmPublishBody: "Everyone in this workspace gets the new version at once.",
    confirmWhileRunning: "While it runs",
    openPopover: "Open popover",
    popoverTitle: "Filter by state",
    popoverBody: "Only agents in the chosen state are listed.",
    menuEdit: "Edit",
    menuDuplicate: "Duplicate",
    menuCopyLink: "Copy link",
    menuRunNow: "Run now",
    menuRunNowReason: "A run is still in progress.",
    menuArchive: "Archive",
    menuView: "View",
    menuShowDrafts: "Show drafts",
    menuShowArchived: "Show archived",
    pickAgent: "Choose agent",
    paletteOpen: "Open palette",
    paletteLabel: "Search",
    paletteConversations: "Conversations",
    paletteNoMatch: "No results.",
    navRowActions: "With marks and actions",
    navRowMore: "More actions",
    skipLinkLabel: "Skip to content",
    skipLinkHint: "The link shows while it holds the focus: press Tab from here.",
    skipLinkTarget: "Content",
    pickWorkspaces: "Workspaces",
    pickRole: "Choose role",
    pickerInDialog: "Picker in a dialog",
    pickerGroupWorkspace: "This workspace",
    pickerGroupInstance: "Instance",
    agentSupportHint: "Answers questions from the handbook",
    agentSupportLongHint:
      "Answers questions from the handbook, names the page it found the answer on and says so when the handbook has none",
    manyAgents: [
      "Accounting",
      "Archive",
      "Audit",
      "Billing",
      "Budget",
      "Compliance",
      "Contracts",
      "Customer care",
      "Data protection",
      "Delivery",
      "Events",
      "Facilities",
      "Finance",
      "Handbook",
      "Hiring",
      "Insurance",
      "Legal",
      "Marketing",
      "Onboarding",
      "Payroll",
      "Procurement",
      "Quality",
      "Research",
      "Sales",
      "Travel",
      "Warehouse"
    ],
    agentResearch: "Research assistant",
    agentResearchHint: "Searches the web and cites its sources",
    agentContracts: "Contract check",
    agentContractsHint: "Compares a contract with the template",
    agentPayroll: "Payroll assistant",
    agentPayrollReason: "Needs a connection that is not set up",
    createAgent: "Create new agent",
    workspaceMarketing: "Marketing",
    workspaceFinance: "Finance",
    workspaceLegal: "Legal",
    instanceName: "Acme",
    personName: "Maria Schmidt",
    groupEditors: "Editors",
    readOnly: "Read-only",
    avatarPerson: "Person",
    avatarWorkspace: "Workspace",
    avatarAgent: "Agent",
    avatarApp: "App",
    bannerInfo: "This agent comes from the instance and is read-only here.",
    bannerSuccess: "Your profile was saved.",
    bannerWarningTitle: "2 steps need a connection",
    bannerWarning: "The workflow cannot run until every step has one.",
    bannerDanger: "The monthly limit is reached. New runs are refused.",
    bannerAction: "Connect",
    bannerPage: "You are working on the staging instance.",
    bannerLine: "Will be deleted automatically on Friday, October 16.",
    showAgain: "Show again",
    noticeSaved: "Saved",
    noticeFailed: "The connection test failed.",
    emptyAgents:
      "No agents in this workspace. Instance agents are available here; create one to specialise.",
    emptyAgentsAction: "New agent",
    emptyPresetBriefing: "Daily briefing",
    emptyPresetReview: "Weekly review",
    emptyPresetTriage: "Mail triage",
    emptyInline: "Nothing scheduled.",
    emptyNoRight: "No apps yet. A builder of this workspace can add one.",
    layoutPage: "Page",
    layoutInline: "Inline",
    layoutNoRight: "Without the right to act",
    skeletonShapes: "Shapes",
    skeletonList: "List",
    skeletonPage: "Page",
    openDialog: "Open dialog",
    dialogTitle: "Delete agent",
    dialogDescription: "The agent and its history are removed for everyone in this workspace.",
    dialogBody: "Conversations that used this agent stay readable.",
    tooltipText: "Copy the link",
    hoverCardTrigger: "Context",
    hoverCardBody: "About a third of the context window is in use.",
    cardTitle: "Support assistant",
    cardBody: "Answers questions from the product handbook.",
    tableName: "Name",
    tableState: "State",
    tableUpdated: "Updated",
    rowAgent: "Support assistant",
    rowWorkflow: "Invoice check",
    rowKnowledge: "Product handbook",
    ...layoutGalleryText.en,
    ...sampleGalleryText.en,
    ...chartGalleryText.en,
    countPending: "3 requests wait",
    today: "Today",
    yesterday: "Yesterday",
    stateDraft: "Draft",
    stateRunning: "Running",
    statePublished: "Published",
    stateNeedsReconnect: "Needs reconnect",
    stateFailed: "Failed",
    stateNew: "New",
    errorMessage: "The changes could not be saved. Try again."
  },
  de: {
    title: "UI-Bibliothek",
    mode: "Modus",
    modeLight: "Hell",
    modeDark: "Dunkel",
    modeBoth: "Beide",
    language: "Sprache",
    groups: "Komponentengruppen",
    groupFoundations: "Grundlagen",
    groupActions: "Aktionen",
    groupForms: "Formulare",
    groupOverlays: "Überlagerungen",
    groupNavigation: "Navigation",
    groupStructure: "Seitenaufbau",
    groupData: "Daten",
    groupStatus: "Status",
    groupFeedback: "Rückmeldung",
    emptyGroup: "Diese Gruppe enthält noch keine Komponenten.",
    colors: "Farben",
    typeStyles: "Schriftstile",
    typeSample: "Zwölf Boxkämpfer jagen Viktor quer über den großen Sylter Deich",
    radius: "Radius",
    shadows: "Schatten",
    controlHeights: "Höhen der Bedienelemente",
    icons: "Symbole",
    focus: "Fokus",
    focusHint: "Drücke Tab, um die Fokuslinie durch diese Bedienelemente zu bewegen.",
    save: "Speichern",
    cancel: "Abbrechen",
    delete: "Löschen",
    publish: "Veröffentlichen",
    learnMore: "Mehr erfahren",
    saving: "Wird gespeichert",
    disabled: "Deaktiviert",
    settings: "Einstellungen",
    addItem: "Hinzufügen",
    moreActions: "Weitere Aktionen",
    name: "Name",
    namePlaceholder: "Support-Assistent",
    searchPlaceholder: "Agenten suchen",
    invalidValue: "Kein gültiger Name",
    instructions: "Anweisungen",
    instructionsSample: "Antworte kurz und nenne deine Quellen.",
    codeSample: "name: support-assistent\nmodel: default",
    role: "Rolle",
    roleMember: "Mitglied",
    roleAdmin: "Administrator",
    enabled: "Aktiviert",
    notifyByEmail: "Per E-Mail benachrichtigen",
    notifyByEmailHint: "Eine Nachricht pro abgeschlossenem Lauf.",
    selectAll: "Alle auswählen",
    acceptTerms: "Ich habe die Nutzungsregeln gelesen",
    visibility: "Sichtbarkeit",
    visibilityDiscoverable: "Auffindbar",
    visibilityDiscoverableHint: "Alle in der Organisation können ihn finden und beitreten.",
    visibilityPrivate: "Privat",
    visibilityPrivateHint: "Nur eingeladene Mitglieder sehen ihn.",
    visibilityArchived: "Archiviert",
    visibilityArchivedHint: "In deinem Tarif nicht verfügbar.",
    visibilityHelp: "Du kannst das später in den Workspace-Einstellungen ändern.",
    availability: "Verfügbar in",
    availabilityAll: "Allen Workspaces",
    availabilitySelected: "Ausgewählten Workspaces",
    nameHint: "Erscheint in der Agentenliste und in jeder Unterhaltung.",
    nameError: "Gib einen Namen mit mindestens drei Zeichen ein.",
    description: "Beschreibung",
    liveChanges: "Live-Änderungen",
    liveChangesHint: "Aktionen im Entwurf ändern echte Daten.",
    confirmDelete: "Agent löschen",
    confirmDeleteTitle: "Support-Assistent löschen?",
    confirmDeleteBody:
      "Der Agent wird für alle in diesem Workspace entfernt. Das lässt sich nicht rückgängig machen.",
    confirmPublish: "Änderungen veröffentlichen",
    confirmPublishTitle: "Support-Assistent veröffentlichen?",
    confirmPublishBody: "Alle in diesem Workspace erhalten sofort die neue Version.",
    confirmWhileRunning: "Während es läuft",
    openPopover: "Popover öffnen",
    popoverTitle: "Nach Status filtern",
    popoverBody: "Es werden nur Agenten im gewählten Status angezeigt.",
    menuEdit: "Bearbeiten",
    menuDuplicate: "Duplizieren",
    menuCopyLink: "Link kopieren",
    menuRunNow: "Jetzt ausführen",
    menuRunNowReason: "Ein Lauf ist noch nicht abgeschlossen.",
    menuArchive: "Archivieren",
    menuView: "Ansicht",
    menuShowDrafts: "Entwürfe anzeigen",
    menuShowArchived: "Archivierte anzeigen",
    pickAgent: "Agent wählen",
    paletteOpen: "Palette öffnen",
    paletteLabel: "Suchen",
    paletteConversations: "Unterhaltungen",
    paletteNoMatch: "Keine Treffer.",
    navRowActions: "Mit Marken und Aktionen",
    navRowMore: "Weitere Aktionen",
    skipLinkLabel: "Zum Inhalt springen",
    skipLinkHint: "Der Link erscheint, solange er den Fokus hat: von hier aus Tab drücken.",
    skipLinkTarget: "Inhalt",
    pickWorkspaces: "Workspaces",
    pickRole: "Rolle wählen",
    pickerInDialog: "Auswahl in einem Dialog",
    pickerGroupWorkspace: "Dieser Workspace",
    pickerGroupInstance: "Instanz",
    agentSupportHint: "Beantwortet Fragen aus dem Handbuch",
    agentSupportLongHint:
      "Beantwortet Fragen aus dem Handbuch, nennt die Seite mit der Antwort und sagt es, wenn das Handbuch keine hat",
    manyAgents: [
      "Abrechnung",
      "Archiv",
      "Audit",
      "Beschaffung",
      "Budget",
      "Compliance",
      "Datenschutz",
      "Einkauf",
      "Events",
      "Finanzen",
      "Gebäude",
      "Handbuch",
      "Inventar",
      "Kundendienst",
      "Lager",
      "Lieferung",
      "Marketing",
      "Onboarding",
      "Personal",
      "Qualität",
      "Recherche",
      "Recht",
      "Reisen",
      "Versicherung",
      "Vertrieb",
      "Verträge"
    ],
    agentResearch: "Recherche-Assistent",
    agentResearchHint: "Durchsucht das Web und nennt Quellen",
    agentContracts: "Vertragsprüfung",
    agentContractsHint: "Vergleicht einen Vertrag mit der Vorlage",
    agentPayroll: "Lohn-Assistent",
    agentPayrollReason: "Braucht eine Verbindung, die nicht eingerichtet ist",
    createAgent: "Neuen Agenten erstellen",
    workspaceMarketing: "Marketing",
    workspaceFinance: "Finanzen",
    workspaceLegal: "Recht",
    instanceName: "Acme",
    personName: "Maria Schmidt",
    groupEditors: "Redaktion",
    readOnly: "Schreibgeschützt",
    avatarPerson: "Person",
    avatarWorkspace: "Workspace",
    avatarAgent: "Agent",
    avatarApp: "App",
    bannerInfo: "Dieser Agent stammt aus der Instanz und ist hier schreibgeschützt.",
    bannerSuccess: "Dein Profil wurde gespeichert.",
    bannerWarningTitle: "2 Schritte brauchen eine Verbindung",
    bannerWarning: "Der Workflow kann erst laufen, wenn jeder Schritt eine hat.",
    bannerDanger: "Das Monatslimit ist erreicht. Neue Läufe werden abgelehnt.",
    bannerAction: "Verbinden",
    bannerPage: "Du arbeitest auf der Staging-Instanz.",
    bannerLine: "Wird am Freitag, 16. Oktober automatisch gelöscht.",
    showAgain: "Wieder anzeigen",
    noticeSaved: "Gespeichert",
    noticeFailed: "Der Verbindungstest ist fehlgeschlagen.",
    emptyAgents:
      "Keine Agenten in diesem Workspace. Instanz-Agenten sind hier verfügbar; erstelle einen eigenen für spezielle Aufgaben.",
    emptyAgentsAction: "Neuer Agent",
    emptyPresetBriefing: "Tägliches Briefing",
    emptyPresetReview: "Wochenrückblick",
    emptyPresetTriage: "E-Mail-Vorsortierung",
    emptyInline: "Nichts geplant.",
    emptyNoRight: "Noch keine Apps. Ein Builder dieses Workspace kann eine hinzufügen.",
    layoutPage: "Seite",
    layoutInline: "Eingebettet",
    layoutNoRight: "Ohne Recht zu handeln",
    skeletonShapes: "Formen",
    skeletonList: "Liste",
    skeletonPage: "Seite",
    openDialog: "Dialog öffnen",
    dialogTitle: "Agent löschen",
    dialogDescription: "Der Agent und sein Verlauf werden für alle in diesem Workspace entfernt.",
    dialogBody: "Unterhaltungen mit diesem Agenten bleiben lesbar.",
    tooltipText: "Link kopieren",
    hoverCardTrigger: "Kontext",
    hoverCardBody: "Etwa ein Drittel des Kontextfensters ist belegt.",
    cardTitle: "Support-Assistent",
    cardBody: "Beantwortet Fragen aus dem Produkthandbuch.",
    tableName: "Name",
    tableState: "Status",
    tableUpdated: "Geändert",
    rowAgent: "Support-Assistent",
    rowWorkflow: "Rechnungsprüfung",
    rowKnowledge: "Produkthandbuch",
    ...layoutGalleryText.de,
    ...sampleGalleryText.de,
    ...chartGalleryText.de,
    countPending: "3 Anfragen warten",
    today: "Heute",
    yesterday: "Gestern",
    stateDraft: "Entwurf",
    stateRunning: "Läuft",
    statePublished: "Veröffentlicht",
    stateNeedsReconnect: "Neu verbinden",
    stateFailed: "Fehlgeschlagen",
    stateNew: "Neu",
    errorMessage: "Die Änderungen konnten nicht gespeichert werden. Versuche es erneut."
  }
};
