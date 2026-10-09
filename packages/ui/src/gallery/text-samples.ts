/** The gallery's text for its section rail, the sample pages and the Decisions page. */
export interface SampleGalleryText {
  sections: string;
  sectionsReview: string;
  sectionSamples: string;
  sampleBuildList: string;
  sampleAssetPage: string;
  sampleSettingsForm: string;
  sampleNote: string;
  buildKinds: string;
  buildAgents: string;
  buildSkills: string;
  buildConnections: string;
  buildKnowledgeBases: string;
  buildDataStores: string;
  buildGuardrails: string;
  buildListDescription: string;
  buildNewKnowledgeBase: string;
  buildSearch: string;
  buildScope: string;
  buildScopeAll: string;
  buildShown: string;
  buildEmpty: string;
  buildClearSearch: string;
  buildListLabel: string;
  buildOpen: string;
  buildWorkspace: string;
  buildInstance: string;
  buildInstanceReadOnly: string;
  buildHandbook: string;
  buildHandbookStatus: string;
  buildContracts: string;
  buildContractsStatus: string;
  buildPolicies: string;
  buildPoliciesStatus: string;
  buildPrices: string;
  buildPricesStatus: string;
  stateIngesting: string;
  stateIngestionFailed: string;
  assetBack: string;
  assetDiscardDraft: string;
  assetExport: string;
  assetBannerTitle: string;
  assetBanner: string;
  assetBannerAction: string;
  assetSections: string;
  assetOverview: string;
  assetOverviewDescription: string;
  assetNameHint: string;
  assetDescriptionValue: string;
  assetSources: string;
  assetSourcesDescription: string;
  assetAddSource: string;
  assetCreateConnection: string;
  assetSourcesLabel: string;
  assetSourceDrive: string;
  assetSourceDriveStatus: string;
  assetSourceWiki: string;
  assetSourceWikiStatus: string;
  assetSourceArchive: string;
  assetSourceArchiveStatus: string;
  assetSourceCrm: string;
  assetSourceCrmReason: string;
  assetSearch: string;
  assetSearchDescription: string;
  assetSearchMode: string;
  assetSearchModeHybrid: string;
  assetSearchModeKeyword: string;
  assetSemantic: string;
  assetSemanticHint: string;
  assetHistory: string;
  assetHistoryDescription: string;
  assetHistoryLabel: string;
  assetRevisionDraft: string;
  assetRevisionDraftStatus: string;
  assetRevisionTwo: string;
  assetRevisionTwoStatus: string;
  assetRevisionOne: string;
  assetRevisionOneStatus: string;
  lastWeek: string;
  settingsGroupInstance: string;
  settingsLanguage: string;
  settingsApiKeys: string;
  settingsUsers: string;
  settingsRoles: string;
  settingsGeneralDescription: string;
  settingsIdentity: string;
  settingsIdentityDescription: string;
  settingsWorkspaceNameHint: string;
  settingsWorkspaceDescription: string;
  settingsConversations: string;
  settingsConversationsDescription: string;
  settingsDefaultAgent: string;
  settingsDefaultAgentHint: string;
  settingsPrivate: string;
  settingsPrivateHint: string;
  settingsJoinRequests: string;
  settingsJoinRequestsHint: string;
  settingsDigest: string;
  settingsDigestHint: string;
}

export const sampleGalleryText: Record<"en" | "de", SampleGalleryText> = {
  en: {
    sections: "Sections of the UI library",
    sectionsReview: "Review",
    sectionSamples: "Sample pages",
    sampleBuildList: "Build list",
    sampleAssetPage: "Asset page",
    sampleSettingsForm: "Settings form",
    sampleNote:
      "Three pages built from the library alone. They show fixed sample data and change nothing.",
    buildKinds: "Build",
    buildAgents: "Agents",
    buildSkills: "Skills",
    buildConnections: "Connections",
    buildKnowledgeBases: "Knowledge bases",
    buildDataStores: "Data stores",
    buildGuardrails: "Guardrails",
    buildListDescription: "What your agents can search.",
    buildNewKnowledgeBase: "New knowledge base",
    buildSearch: "Search knowledge bases",
    buildScope: "Scope",
    buildScopeAll: "All I can see",
    buildShown: "{count} of 4",
    buildEmpty: "No knowledge base matches these filters.",
    buildClearSearch: "Clear filters",
    buildListLabel: "Knowledge bases",
    buildOpen: "Open",
    buildWorkspace: "Product team",
    buildInstance: "Instance",
    buildInstanceReadOnly: "Instance asset. Editing needs Builder at instance scope.",
    buildHandbook: "Product handbook",
    buildHandbookStatus: "2 sources, 214 documents. Last ingestion today.",
    buildContracts: "Contract templates",
    buildContractsStatus: "1 source, 38 documents. Last ingestion yesterday.",
    buildPolicies: "Company policies",
    buildPoliciesStatus: "3 sources, 1,204 documents. Ingestion running.",
    buildPrices: "Price lists",
    buildPricesStatus: "1 source. The last ingestion failed.",
    stateIngesting: "Ingesting",
    stateIngestionFailed: "Ingestion failed",
    assetBack: "Back to knowledge bases",
    assetDiscardDraft: "Discard draft",
    assetExport: "Export definition",
    assetBannerTitle: "Publishing re-indexes 214 documents",
    assetBanner: "Search keeps answering from the published index until the new one is ready.",
    assetBannerAction: "Show changes",
    assetSections: "Sections of this knowledge base",
    assetOverview: "Overview",
    assetOverviewDescription: "The name and what this knowledge base holds.",
    assetNameHint: "Agents and builders see this name.",
    assetDescriptionValue: "Manuals, release notes and answers of the support team.",
    assetSources: "Sources",
    assetSourcesDescription: "Connections this knowledge base ingests from.",
    assetAddSource: "Add source",
    assetCreateConnection: "Create new connection",
    assetSourcesLabel: "Sources",
    assetSourceDrive: "Shared drive",
    assetSourceDriveStatus: "Folder Handbook. 180 documents.",
    assetSourceWiki: "Team wiki",
    assetSourceWikiStatus: "Space Product. 34 documents.",
    assetSourceArchive: "Document archive",
    assetSourceArchiveStatus: "Read access to the archive",
    assetSourceCrm: "Customer database",
    assetSourceCrmReason: "Needs to be reconnected first",
    assetSearch: "Search",
    assetSearchDescription: "How agents find documents here.",
    assetSearchMode: "Search mode",
    assetSearchModeHybrid: "Semantic and keyword",
    assetSearchModeKeyword: "Keyword only",
    assetSemantic: "Semantic search",
    assetSemanticHint: "Finds documents by meaning. Turning it off needs no re-index.",
    assetHistory: "History",
    assetHistoryDescription: "Every published revision and the open draft.",
    assetHistoryLabel: "Revisions",
    assetRevisionDraft: "Draft",
    assetRevisionDraftStatus: "Alex Morgan added the source Team wiki.",
    assetRevisionTwo: "Revision 2",
    assetRevisionTwoStatus: "Published by Maria Schmidt.",
    assetRevisionOne: "Revision 1",
    assetRevisionOneStatus: "Published by Alex Morgan.",
    lastWeek: "Last week",
    settingsGroupInstance: "Instance",
    settingsLanguage: "Language and appearance",
    settingsApiKeys: "API keys",
    settingsUsers: "Users",
    settingsRoles: "Roles",
    settingsGeneralDescription: "Changes here apply to everyone in this workspace.",
    settingsIdentity: "Name and description",
    settingsIdentityDescription: "How the workspace shows in the sidebar and in scope chips.",
    settingsWorkspaceNameHint: "Up to 40 characters.",
    settingsWorkspaceDescription: "Plans, builds and supports the product.",
    settingsConversations: "Conversations",
    settingsConversationsDescription: "What a new conversation in this workspace starts with.",
    settingsDefaultAgent: "Default agent",
    settingsDefaultAgentHint: "A member can pick another agent in every conversation.",
    settingsPrivate: "New conversations are private",
    settingsPrivateHint: "Only the person who started a conversation sees it until they share it.",
    settingsJoinRequests: "People can ask to join",
    settingsJoinRequestsHint: "Requests show under Members until an owner decides.",
    settingsDigest: "Weekly summary by email",
    settingsDigestHint: "Owners get the workspace's usage every Monday."
  },
  de: {
    sections: "Abschnitte der UI-Bibliothek",
    sectionsReview: "Prüfung",
    sectionSamples: "Beispielseiten",
    sampleBuildList: "Bauen-Liste",
    sampleAssetPage: "Asset-Seite",
    sampleSettingsForm: "Einstellungsformular",
    sampleNote:
      "Drei Seiten, nur aus der Bibliothek gebaut. Sie zeigen feste Beispieldaten und ändern nichts.",
    buildKinds: "Bauen",
    buildAgents: "Agenten",
    buildSkills: "Skills",
    buildConnections: "Verbindungen",
    buildKnowledgeBases: "Wissensbasen",
    buildDataStores: "Datenspeicher",
    buildGuardrails: "Leitplanken",
    buildListDescription: "Was deine Agenten durchsuchen können.",
    buildNewKnowledgeBase: "Neue Wissensbasis",
    buildSearch: "Wissensbasen durchsuchen",
    buildScope: "Geltungsbereich",
    buildScopeAll: "Alles, was ich sehe",
    buildShown: "{count} von 4",
    buildEmpty: "Keine Wissensbasis passt zu diesen Filtern.",
    buildClearSearch: "Filter zurücksetzen",
    buildListLabel: "Wissensbasen",
    buildOpen: "Öffnen",
    buildWorkspace: "Produktteam",
    buildInstance: "Instanz",
    buildInstanceReadOnly: "Instanz-Asset. Zum Bearbeiten brauchst du Builder auf Instanzebene.",
    buildHandbook: "Produkthandbuch",
    buildHandbookStatus: "2 Quellen, 214 Dokumente. Zuletzt heute eingelesen.",
    buildContracts: "Vertragsvorlagen",
    buildContractsStatus: "1 Quelle, 38 Dokumente. Zuletzt gestern eingelesen.",
    buildPolicies: "Unternehmensrichtlinien",
    buildPoliciesStatus: "3 Quellen, 1.204 Dokumente. Wird eingelesen.",
    buildPrices: "Preislisten",
    buildPricesStatus: "1 Quelle. Das letzte Einlesen ist fehlgeschlagen.",
    stateIngesting: "Wird eingelesen",
    stateIngestionFailed: "Einlesen fehlgeschlagen",
    assetBack: "Zurück zu den Wissensbasen",
    assetDiscardDraft: "Entwurf verwerfen",
    assetExport: "Definition exportieren",
    assetBannerTitle: "Beim Veröffentlichen werden 214 Dokumente neu indexiert",
    assetBanner:
      "Die Suche antwortet weiter aus dem veröffentlichten Index, bis der neue fertig ist.",
    assetBannerAction: "Änderungen zeigen",
    assetSections: "Abschnitte dieser Wissensbasis",
    assetOverview: "Überblick",
    assetOverviewDescription: "Der Name und was diese Wissensbasis enthält.",
    assetNameHint: "Agenten und Builder sehen diesen Namen.",
    assetDescriptionValue: "Handbücher, Versionshinweise und Antworten des Support-Teams.",
    assetSources: "Quellen",
    assetSourcesDescription: "Verbindungen, aus denen diese Wissensbasis einliest.",
    assetAddSource: "Quelle hinzufügen",
    assetCreateConnection: "Neue Verbindung erstellen",
    assetSourcesLabel: "Quellen",
    assetSourceDrive: "Gemeinsames Laufwerk",
    assetSourceDriveStatus: "Ordner Handbuch. 180 Dokumente.",
    assetSourceWiki: "Team-Wiki",
    assetSourceWikiStatus: "Bereich Produkt. 34 Dokumente.",
    assetSourceArchive: "Dokumentenarchiv",
    assetSourceArchiveStatus: "Lesezugriff auf das Archiv",
    assetSourceCrm: "Kundendatenbank",
    assetSourceCrmReason: "Muss zuerst neu verbunden werden",
    assetSearch: "Suche",
    assetSearchDescription: "Wie Agenten hier Dokumente finden.",
    assetSearchMode: "Suchmodus",
    assetSearchModeHybrid: "Semantisch und Stichwort",
    assetSearchModeKeyword: "Nur Stichwort",
    assetSemantic: "Semantische Suche",
    assetSemanticHint:
      "Findet Dokumente nach Bedeutung. Zum Ausschalten ist keine neue Indexierung nötig.",
    assetHistory: "Verlauf",
    assetHistoryDescription: "Jede veröffentlichte Revision und der offene Entwurf.",
    assetHistoryLabel: "Revisionen",
    assetRevisionDraft: "Entwurf",
    assetRevisionDraftStatus: "Alex Morgan hat die Quelle Team-Wiki hinzugefügt.",
    assetRevisionTwo: "Revision 2",
    assetRevisionTwoStatus: "Veröffentlicht von Maria Schmidt.",
    assetRevisionOne: "Revision 1",
    assetRevisionOneStatus: "Veröffentlicht von Alex Morgan.",
    lastWeek: "Letzte Woche",
    settingsGroupInstance: "Instanz",
    settingsLanguage: "Sprache und Darstellung",
    settingsApiKeys: "API-Schlüssel",
    settingsUsers: "Benutzer",
    settingsRoles: "Rollen",
    settingsGeneralDescription: "Änderungen hier gelten für alle in diesem Arbeitsbereich.",
    settingsIdentity: "Name und Beschreibung",
    settingsIdentityDescription:
      "So erscheint der Arbeitsbereich in der Seitenleiste und in Bereichs-Chips.",
    settingsWorkspaceNameHint: "Bis zu 40 Zeichen.",
    settingsWorkspaceDescription: "Plant, baut und betreut das Produkt.",
    settingsConversations: "Unterhaltungen",
    settingsConversationsDescription:
      "Womit eine neue Unterhaltung in diesem Arbeitsbereich beginnt.",
    settingsDefaultAgent: "Standard-Agent",
    settingsDefaultAgentHint:
      "Mitglieder können in jeder Unterhaltung einen anderen Agenten wählen.",
    settingsPrivate: "Neue Unterhaltungen sind privat",
    settingsPrivateHint: "Nur wer eine Unterhaltung begonnen hat, sieht sie, bis sie geteilt wird.",
    settingsJoinRequests: "Personen können den Beitritt anfragen",
    settingsJoinRequestsHint:
      "Anfragen stehen unter Mitglieder, bis eine verantwortliche Person entscheidet.",
    settingsDigest: "Wöchentliche Zusammenfassung per E-Mail",
    settingsDigestHint: "Verantwortliche erhalten jeden Montag die Nutzung des Arbeitsbereichs."
  }
};
