// @rights-copy: included in the rights wording guard.
import { RIGHT_VERB_WORDS } from "@work-shape/catalyst-core";
import { defineTranslations } from "./translation-area";

/**
 * The words of a right on every rights screen: one verb per action, said the same way on
 * Instance > Access, Users, API access, a workspace's members and a Connection's page. The verbs
 * are core's, so an agent's refusal says a right in the same words.
 */
export const rights = defineTranslations({
  en: {
    "rights.verbRead": RIGHT_VERB_WORDS.read.en,
    "rights.verbUse": RIGHT_VERB_WORDS.use.en,
    "rights.verbWrite": RIGHT_VERB_WORDS.write.en,
    "rights.verbPublish": RIGHT_VERB_WORDS.publish.en,
    "rights.verbDelete": RIGHT_VERB_WORDS.delete.en,
    "rights.verbApprove": RIGHT_VERB_WORDS.approve.en,
    "rights.verbOnAgents": "{verb} agents",
    "rights.verbOnSkills": "{verb} skills",
    "rights.verbOnConnections": "{verb} connections",
    "rights.verbOnApps": "{verb} apps",
    "rights.verbOnWorkflows": "{verb} workflows",
    "rights.verbOnDataStores": "{verb} data stores",
    "rights.verbOnKnowledgeBases": "{verb} knowledge bases",
    "rights.verbOnGuardrails": "{verb} guardrails",
    "rights.actionWorkflowReadRunData": "View the data of workflow runs",
    "rights.actionDataStoreInsert": "Add rows to data stores",
    "rights.actionDataStoreExecute": "Change and delete rows in data stores",
    "rights.actionDataStoreRecords": "Review extracted fields in data stores",
    "rights.actionMailSenderUse": "Send e-mail as a sender of the instance",
    "rights.actionOperationsApprove": "Approve operation calls",
    "rights.actionFeedbackReview": "Review feedback on agents",
    "rights.actionUsersManage": "Manage users",
    "rights.actionUsageView": "View usage",
    "rights.actionAuditView": "View audit log",
    "rights.actionApiAccessManage": "Manage API access",
    "rights.actionServicePrincipalsManage": "Manage service principals",
    "rights.actionAgentModelsManage": "Manage agent model settings",
    "rights.actionRolesEditBuiltIn": "Edit the built-in roles User and Admin",
    "rights.actionAssetsRelease": "Push configuration releases",
    "rights.actionBuilder": "Builder",
    "rights.actionPublisher": "Publisher",
    "rights.actionUnknown": "A right this version does not know"
  },
  de: {
    "rights.verbRead": RIGHT_VERB_WORDS.read.de,
    "rights.verbUse": RIGHT_VERB_WORDS.use.de,
    "rights.verbWrite": RIGHT_VERB_WORDS.write.de,
    "rights.verbPublish": RIGHT_VERB_WORDS.publish.de,
    "rights.verbDelete": RIGHT_VERB_WORDS.delete.de,
    "rights.verbApprove": RIGHT_VERB_WORDS.approve.de,
    "rights.verbOnAgents": "Agenten {verb}",
    "rights.verbOnSkills": "Skills {verb}",
    "rights.verbOnConnections": "Verbindungen {verb}",
    "rights.verbOnApps": "Apps {verb}",
    "rights.verbOnWorkflows": "Workflows {verb}",
    "rights.verbOnDataStores": "Datenspeicher {verb}",
    "rights.verbOnKnowledgeBases": "Wissensbasen {verb}",
    "rights.verbOnGuardrails": "Leitplanken {verb}",
    "rights.actionWorkflowReadRunData": "Daten der Workflow-Läufe ansehen",
    "rights.actionDataStoreInsert": "Datensätze zu Datenspeichern hinzufügen",
    "rights.actionDataStoreExecute": "Datensätze in Datenspeichern ändern und löschen",
    "rights.actionDataStoreRecords": "Extrahierte Felder in Datenspeichern prüfen",
    "rights.actionMailSenderUse": "E-Mails als Absender der Instanz senden",
    "rights.actionOperationsApprove": "Aufrufe von Operationen freigeben",
    "rights.actionFeedbackReview": "Feedback zu Agenten prüfen",
    "rights.actionUsersManage": "Benutzer verwalten",
    "rights.actionUsageView": "Nutzung ansehen",
    "rights.actionAuditView": "Auditprotokoll ansehen",
    "rights.actionApiAccessManage": "API-Zugriff verwalten",
    "rights.actionServicePrincipalsManage": "Technische Konten verwalten",
    "rights.actionAgentModelsManage": "Modelleinstellungen der Agenten verwalten",
    "rights.actionRolesEditBuiltIn": "Eingebaute Rollen Benutzer und Admin bearbeiten",
    "rights.actionAssetsRelease": "Konfiguration per Release einspielen",
    "rights.actionBuilder": "Builder",
    "rights.actionPublisher": "Publisher",
    "rights.actionUnknown": "Ein Recht, das diese Version nicht kennt"
  }
});
