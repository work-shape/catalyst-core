import { defineTranslations } from "./translation-area";

// The words of Instance > Access for the kinds and rights RIGHTS-1c makes grantable: Apps, Data
// Stores, deleting a Workflow or a Knowledge Base, and reading a Workflow's run data. Kept apart
// from `access.ts`, whose wording RIGHTS-WORDS changes.
export const accessKinds = defineTranslations({
  en: {
    "access.actionReadRunData": "Read run data",
    "access.actionReadRunDataWorkflowDescription":
      "Read the data the Workflow's runs read and wrote, such as the rows of their datasets.",
    "access.actionReadRunDataWorkflowNote":
      "Giving it also needs every right of the service principal the Workflow runs as, because the data is what that principal reads.",
    "access.actionDeleteWorkflowDescription": "Delete the Workflow. Its runs stay readable.",
    "access.actionDeleteKnowledgeBaseDescription":
      "Delete the Knowledge Base. Documents it keeps itself are deleted with it; a Data Store it describes stays as it is.",
    "access.actionOnApp": "{action} Apps",
    "access.scopeApp": "App {name}",
    "access.scopeOnApp": "On one App",
    "access.scopeOnAppDescription": "One existing App.",
    "access.grantApp": "App",
    "access.chooseApp": "Choose an App",
    "access.noApps": "This instance has no App yet.",
    "access.appsLoadFailed": "The Apps could not be loaded.",
    "access.actionOnDataStore": "{action} Data Stores",
    "access.scopeDataStore": "Data Store {name}",
    "access.scopeOnDataStore": "On one Data Store",
    "access.scopeOnDataStoreDescription": "One existing Data Store.",
    "access.grantDataStore": "Data Store",
    "access.chooseDataStore": "Choose a Data Store",
    "access.noDataStores": "This instance has no Data Store yet.",
    "access.dataStoresLoadFailed": "The Data Stores could not be loaded."
  },
  de: {
    "access.actionReadRunData": "Laufdaten lesen",
    "access.actionReadRunDataWorkflowDescription":
      "Die Daten lesen, die die Läufe des Workflows gelesen und geschrieben haben, etwa die Zeilen ihrer Datensätze.",
    "access.actionReadRunDataWorkflowNote":
      "Zum Vergeben braucht die Person außerdem jedes Recht des Service Principals, als der der Workflow läuft, denn die Daten sind das, was er liest.",
    "access.actionDeleteWorkflowDescription": "Den Workflow löschen. Seine Läufe bleiben lesbar.",
    "access.actionDeleteKnowledgeBaseDescription":
      "Die Wissensbasis löschen. Dokumente, die sie selbst hält, werden mit ihr gelöscht; ein Datenspeicher, den sie beschreibt, bleibt, wie er ist.",
    "access.actionOnApp": "Apps: {action}",
    "access.scopeApp": "App {name}",
    "access.scopeOnApp": "An einer App",
    "access.scopeOnAppDescription": "Eine vorhandene App.",
    "access.grantApp": "App",
    "access.chooseApp": "App wählen",
    "access.noApps": "Auf dieser Instanz gibt es noch keine App.",
    "access.appsLoadFailed": "Die Apps konnten nicht geladen werden.",
    "access.actionOnDataStore": "Datenspeicher: {action}",
    "access.scopeDataStore": "Datenspeicher {name}",
    "access.scopeOnDataStore": "An einem Datenspeicher",
    "access.scopeOnDataStoreDescription": "Ein vorhandener Datenspeicher.",
    "access.grantDataStore": "Datenspeicher",
    "access.chooseDataStore": "Datenspeicher wählen",
    "access.noDataStores": "Auf dieser Instanz gibt es noch keinen Datenspeicher.",
    "access.dataStoresLoadFailed": "Die Datenspeicher konnten nicht geladen werden."
  }
});
