// @rights-copy: included in the rights wording guard.
import { defineTranslations } from "./translation-area";

// Instance > Access: the words of the keys `admin/access/kinds/guardrail.ts` names.
export const accessGuardrail = defineTranslations({
  en: {
    "access.actionPublishGuardrailDescription":
      "Make a guardrail of this workspace enforce, or stop it. A guardrail stops other people's work in the workspace.",
    "access.scopeGuardrail": "Guardrail {name}",
    "access.scopeOnGuardrail": "On one guardrail",
    "access.scopeOnGuardrailDescription": "Guardrails are granted for one workspace.",
    "access.grantGuardrail": "Guardrail",
    "access.chooseGuardrail": "Choose a guardrail",
    "access.noGuardrails": "This instance has no guardrail yet.",
    "access.guardrailsLoadFailed": "The guardrails could not be loaded.",
    "access.kindGuardrail": "Guardrails",
    "access.objectGuardrail": "the guardrail {name}"
  },
  de: {
    "access.actionPublishGuardrailDescription":
      "Eine Leitplanke dieses Arbeitsbereichs in Kraft setzen oder anhalten. Eine Leitplanke hält die Arbeit anderer im Arbeitsbereich auf.",
    "access.scopeGuardrail": "Leitplanke {name}",
    "access.scopeOnGuardrail": "An einer Leitplanke",
    "access.scopeOnGuardrailDescription": "Leitplanken werden für einen Arbeitsbereich vergeben.",
    "access.grantGuardrail": "Leitplanke",
    "access.chooseGuardrail": "Leitplanke wählen",
    "access.noGuardrails": "Auf dieser Instanz gibt es noch keine Leitplanke.",
    "access.guardrailsLoadFailed": "Die Leitplanken konnten nicht geladen werden.",
    "access.kindGuardrail": "Leitplanken",
    "access.objectGuardrail": "die Leitplanke {name}"
  }
});
