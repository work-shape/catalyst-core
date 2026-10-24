// @rights-copy: included in the rights wording guard.
import { defineTranslations } from "./translation-area";

// Instance > Access: the words of the keys `admin/access/kinds/users.ts` names.
export const accessUsers = defineTranslations({
  en: {
    "access.kindUsers": "Users",
    "access.actionDeleteUsersDescription":
      "Delete a person's account and everything they own here. Only for people whose rights you hold yourself."
  },
  de: {
    "access.kindUsers": "Benutzer",
    "access.actionDeleteUsersDescription":
      "Das Konto einer Person löschen und alles, was ihr hier gehört. Nur bei Personen, deren Rechte du selbst hast."
  }
});
