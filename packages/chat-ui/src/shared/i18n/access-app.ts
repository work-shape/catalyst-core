// @rights-copy: included in the rights wording guard.
import { defineTranslations } from "./translation-area";

// Instance > Access: the words of the keys `admin/access/kinds/app.ts` names.
export const accessApp = defineTranslations({
  en: {
    "access.kindApp": "Apps",
    "access.objectApp": "the App {name}",
    "access.actionOnApp": "{action} Apps",
    "access.scopeApp": "App {name}",
    "access.scopeOnApp": "On one App",
    "access.scopeOnAppDescription": "One existing App.",
    "access.grantApp": "App",
    "access.chooseApp": "Choose an App",
    "access.noApps": "There is no App yet.",
    "access.appsLoadFailed": "The Apps could not be loaded."
  },
  de: {
    "access.kindApp": "Apps",
    "access.objectApp": "die App {name}",
    "access.actionOnApp": "Apps: {action}",
    "access.scopeApp": "App {name}",
    "access.scopeOnApp": "An einer App",
    "access.scopeOnAppDescription": "Eine vorhandene App.",
    "access.grantApp": "App",
    "access.chooseApp": "App wählen",
    "access.noApps": "Es gibt noch keine App.",
    "access.appsLoadFailed": "Die Apps konnten nicht geladen werden."
  }
});
