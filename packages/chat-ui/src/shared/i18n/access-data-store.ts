// @rights-copy: included in the rights wording guard.
import { defineTranslations } from "./translation-area";

// Instance > Access: the words of the keys `admin/access/kinds/data-store.ts` names.
export const accessDataStore = defineTranslations({
  en: {
    "access.kindDataStore": "Data stores",
    "access.objectDataStore": "the Data Store {name}",
    "access.actionExecuteDataStoreDescription": "Needs View as well, to find the rows.",
    "access.actionOnDataStore": "{action} Data Stores",
    "access.scopeDataStore": "Data Store {name}",
    "access.scopeOnDataStore": "On one Data Store",
    "access.scopeOnDataStoreDescription": "One existing Data Store.",
    "access.grantDataStore": "Data Store",
    "access.chooseDataStore": "Choose a Data Store",
    "access.noDataStores": "There is no Data Store yet.",
    "access.dataStoresLoadFailed": "The Data Stores could not be loaded."
  },
  de: {
    "access.kindDataStore": "Datenspeicher",
    "access.objectDataStore": "den Datenspeicher {name}",
    "access.actionExecuteDataStoreDescription":
      "Braucht auch Ansehen, um die Datensätze zu finden.",
    "access.actionOnDataStore": "Datenspeicher: {action}",
    "access.scopeDataStore": "Datenspeicher {name}",
    "access.scopeOnDataStore": "An einem Datenspeicher",
    "access.scopeOnDataStoreDescription": "Ein vorhandener Datenspeicher.",
    "access.grantDataStore": "Datenspeicher",
    "access.chooseDataStore": "Datenspeicher wählen",
    "access.noDataStores": "Es gibt noch keinen Datenspeicher.",
    "access.dataStoresLoadFailed": "Die Datenspeicher konnten nicht geladen werden."
  }
});
