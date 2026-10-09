export type GalleryLanguage = "en" | "de";

/** Every text the gallery shows, in both interface languages. Component names are not translated. */
export interface GalleryText {
  title: string;
  mode: string;
  modeLight: string;
  modeDark: string;
  modeBoth: string;
  language: string;
  theme: string;
  themeDefault: string;
  themeTeal: string;
  themePrevious: string;
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
  pickWorkspaces: string;
  pickRole: string;
  pickerInDialog: string;
  pickerGroupWorkspace: string;
  pickerGroupInstance: string;
  agentSupportHint: string;
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
  navMain: string;
  navWorkspace: string;
  navWorkspaceInitials: string;
  navAccount: string;
  navAccountInitials: string;
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
  saveStickyBody: string;
  placeholderNote: string;
  rowAgentStatus: string;
  rowWorkflowStatus: string;
  rowKnowledgeStatus: string;
  rowPerson: string;
  rowPersonInitials: string;
  rowPersonStatus: string;
  rowAgentInitials: string;
  rowWorkflowInitials: string;
  rowKnowledgeInitials: string;
  rowScopeInstance: string;
  rowModeLink: string;
  rowModeButton: string;
  rowModeExpandable: string;
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
    theme: "Theme",
    themeDefault: "Default",
    themeTeal: "Teal accent",
    themePrevious: "Previous default",
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
    pickWorkspaces: "Workspaces",
    pickRole: "Choose role",
    pickerInDialog: "Picker in a dialog",
    pickerGroupWorkspace: "This workspace",
    pickerGroupInstance: "Instance",
    agentSupportHint: "Answers questions from the handbook",
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
    navMain: "Main navigation",
    navWorkspace: "Product team",
    navWorkspaceInitials: "PT",
    navAccount: "Alex Morgan",
    navAccountInitials: "AM",
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
    saveStickyBody: "Scroll this form: the bar stays at its bottom edge.",
    placeholderNote: "Placeholder until Avatar and EmptyState from G-5b are joined.",
    rowAgentStatus: "Published. Used in 48 conversations this week.",
    rowWorkflowStatus: "Running. Next start tomorrow at 08:00.",
    rowKnowledgeStatus: "Draft. 214 documents.",
    rowPerson: "Alex Morgan",
    rowPersonInitials: "AM",
    rowPersonStatus: "Administrator. Last active today.",
    rowAgentInitials: "SA",
    rowWorkflowInitials: "IC",
    rowKnowledgeInitials: "PH",
    rowScopeInstance: "Instance",
    rowModeLink: "As a link",
    rowModeButton: "As a button, selectable",
    rowModeExpandable: "Expandable",
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
    countDot: "Dot",
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
    theme: "Design",
    themeDefault: "Standard",
    themeTeal: "Akzent Petrol",
    themePrevious: "Bisheriger Standard",
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
    pickWorkspaces: "Workspaces",
    pickRole: "Rolle wählen",
    pickerInDialog: "Auswahl in einem Dialog",
    pickerGroupWorkspace: "Dieser Workspace",
    pickerGroupInstance: "Instanz",
    agentSupportHint: "Beantwortet Fragen aus dem Handbuch",
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
    navMain: "Hauptnavigation",
    navWorkspace: "Produktteam",
    navWorkspaceInitials: "PT",
    navAccount: "Alex Morgan",
    navAccountInitials: "AM",
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
    saveStickyBody: "Scrolle dieses Formular: Die Leiste bleibt am unteren Rand.",
    placeholderNote: "Platzhalter, bis Avatar und EmptyState aus G-5b eingefügt sind.",
    rowAgentStatus: "Veröffentlicht. Diese Woche in 48 Unterhaltungen genutzt.",
    rowWorkflowStatus: "Läuft. Nächster Start morgen um 08:00.",
    rowKnowledgeStatus: "Entwurf. 214 Dokumente.",
    rowPerson: "Alex Morgan",
    rowPersonInitials: "AM",
    rowPersonStatus: "Administrator. Heute zuletzt aktiv.",
    rowAgentInitials: "SA",
    rowWorkflowInitials: "RP",
    rowKnowledgeInitials: "PH",
    rowScopeInstance: "Instanz",
    rowModeLink: "Als Link",
    rowModeButton: "Als Schaltfläche, auswählbar",
    rowModeExpandable: "Aufklappbar",
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
    countDot: "Punkt",
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
