// @rights-copy: included in the rights wording guard.
import { defineTranslations } from "./translation-area";

// Instance > Access: the words of the keys `admin/access/kinds/system.ts` names.
export const accessSystem = defineTranslations({
  en: {
    "access.kindSystem": "System",
    "access.actionViewSystemDescription":
      "See the System pages: background jobs, operation runs, modules and what the instance runs on."
  },
  de: {
    "access.kindSystem": "System",
    "access.actionViewSystemDescription":
      "Die Seiten unter System ansehen: Jobs im Hintergrund, Aufrufe von Operationen, Module und worauf die Instanz läuft."
  }
});
