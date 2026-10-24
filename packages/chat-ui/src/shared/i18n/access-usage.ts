// @rights-copy: included in the rights wording guard.
import { defineTranslations } from "./translation-area";

// Instance > Access: the words of the keys `admin/access/kinds/usage.ts` names.
export const accessUsage = defineTranslations({
  en: {
    "access.kindUsage": "Usage",
    "access.actionViewUsageUsersDescription":
      "See what each person used, by name: everyone for the instance, the members of one workspace for a workspace. Every look is recorded."
  },
  de: {
    "access.kindUsage": "Nutzung",
    "access.actionViewUsageUsersDescription":
      "Sehen, was jede Person verbraucht hat, mit Namen: alle für die Instanz, die Mitglieder eines Arbeitsbereichs für einen Arbeitsbereich. Jeder Blick darauf wird protokolliert."
  }
});
