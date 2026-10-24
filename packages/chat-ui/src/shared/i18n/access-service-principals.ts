// @rights-copy: included in the rights wording guard.
import { defineTranslations } from "./translation-area";

// Instance > Access: the words of the keys `admin/access/kinds/service-principals.ts` names.
export const accessServicePrincipals = defineTranslations({
  en: {
    "access.kindServicePrincipals": "Service principals",
    "access.actionManageServicePrincipalsDescription":
      "Create service principals, switch them on and off, and give them only rights you hold yourself. Their keys need “Manage API access”."
  },
  de: {
    "access.kindServicePrincipals": "Technische Konten",
    "access.actionManageServicePrincipalsDescription":
      "Technische Konten anlegen, ein- und ausschalten und ihnen nur Rechte geben, die du selbst hast. Für ihre Schlüssel braucht es „API-Zugriff verwalten“."
  }
});
