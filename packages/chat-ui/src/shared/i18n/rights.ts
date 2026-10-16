// @rights-copy: included in the rights wording guard.
import { defineTranslations } from "./translation-area";

/**
 * The words of a right on every rights screen: one verb per action, said the same way on
 * Instance > Access, Users, API access, a workspace's members and a Connection's page.
 */
export const rights = defineTranslations({
  en: {
    "rights.verbRead": "view",
    "rights.verbUse": "use",
    "rights.verbWrite": "edit",
    "rights.verbPublish": "publish",
    "rights.verbDelete": "delete",
    "rights.verbApprove": "approve",
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
    "rights.actionDataStoreExecute": "Run queries on data stores",
    "rights.actionOperationsApprove": "Approve operation calls",
    "rights.actionUsersManage": "Manage users",
    "rights.actionUsageView": "View usage",
    "rights.actionAuditView": "View audit log",
    "rights.actionApiAccessManage": "Manage API access",
    "rights.actionServicePrincipalsManage": "Manage service principals",
    "rights.actionAgentModelsManage": "Manage agent model settings",
    "rights.actionAssetsRelease": "Push configuration releases",
    "rights.actionUnknown": "A right this version does not know"
  },
  de: {
    "rights.verbRead": "ansehen",
    "rights.verbUse": "verwenden",
    "rights.verbWrite": "bearbeiten",
    "rights.verbPublish": "veröffentlichen",
    "rights.verbDelete": "löschen",
    "rights.verbApprove": "freigeben",
    "rights.verbOnAgents": "Agenten {verb}",
    "rights.verbOnSkills": "Skills {verb}",
    "rights.verbOnConnections": "Verbindungen {verb}",
    "rights.verbOnApps": "Apps {verb}",
    "rights.verbOnWorkflows": "Workflows {verb}",
    "rights.verbOnDataStores": "Datenspeicher {verb}",
    "rights.verbOnKnowledgeBases": "Wissensbasen {verb}",
    "rights.verbOnGuardrails": "Leitplanken {verb}",
    "rights.actionWorkflowReadRunData": "Daten der Workflow-Läufe ansehen",
    "rights.actionDataStoreInsert": "Zeilen in Datenspeicher einfügen",
    "rights.actionDataStoreExecute": "Abfragen auf Datenspeichern ausführen",
    "rights.actionOperationsApprove": "Aufrufe von Operationen freigeben",
    "rights.actionUsersManage": "Benutzer verwalten",
    "rights.actionUsageView": "Nutzung ansehen",
    "rights.actionAuditView": "Auditprotokoll ansehen",
    "rights.actionApiAccessManage": "API-Zugriff verwalten",
    "rights.actionServicePrincipalsManage": "Technische Konten verwalten",
    "rights.actionAgentModelsManage": "Modelleinstellungen der Agenten verwalten",
    "rights.actionAssetsRelease": "Konfiguration per Release einspielen",
    "rights.actionUnknown": "Ein Recht, das diese Version nicht kennt"
  }
});
