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
