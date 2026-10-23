import { defineTranslations } from "./translation-area";

/** A person's own confirmation settings (OP-6): You > Confirmations and "Always allow". */
export const confirmations = defineTranslations({
  en: {
    "settings.confirmations": "Confirmations",
    "confirm.alwaysAllow": "Always allow",
    "confirm.askMe": "Ask me",
    "confirm.never": "Never",
    "confirm.default": "As set by your administrator",
    "confirm.alwaysAllowHint":
      "Always allow also lets your scheduled runs do this without asking. You can change it in Settings.",
    "confirm.alwaysAllowed": "Allowed. From now on this runs without asking you.",
    "confirm.alwaysAllowRefused":
      "Always allow is no longer available for this action. Allow or deny it this once.",
    "confirm.description":
      "Choose for each action whether your agents ask you first. This applies to your own conversations and scheduled runs, never to other people's or to Workflows. Your administrator's settings still apply.",
    "confirm.actions": "Actions",
    "confirm.empty":
      "No actions yet. Actions your agents ask you about appear here, and so does every choice you made.",
    "confirm.listFailed": "Your confirmations could not be loaded.",
    "confirm.saveFailed": "Your choice was not saved. Try again.",
    "confirm.valueFor": "When your agents call {action}",
    "confirm.lockedByAdmin": "Your administrator decides whether this asks first.",
    "confirm.notReversible": "Always allow is not available: this action cannot be undone easily.",
    "confirm.gone": "This action no longer exists."
  },
  de: {
    "settings.confirmations": "Bestätigungen",
    "confirm.alwaysAllow": "Immer erlauben",
    "confirm.askMe": "Frag mich",
    "confirm.never": "Nie",
    "confirm.default": "Wie von deinem Administrator eingestellt",
    "confirm.alwaysAllowHint":
      "Immer erlauben gilt auch für deine geplanten Ausführungen. Du kannst es in den Einstellungen ändern.",
    "confirm.alwaysAllowed": "Erlaubt. Ab jetzt läuft das, ohne dich zu fragen.",
    "confirm.alwaysAllowRefused":
      "Immer erlauben ist für diese Aktion nicht mehr verfügbar. Erlaube oder lehne sie dieses eine Mal ab.",
    "confirm.description":
      "Wähle für jede Aktion, ob deine Agenten dich vorher fragen. Das gilt für deine eigenen Unterhaltungen und geplanten Ausführungen, nie für die anderer Personen oder für Workflows. Die Einstellungen deines Administrators gelten weiter.",
    "confirm.actions": "Aktionen",
    "confirm.empty":
      "Noch keine Aktionen. Hier erscheinen Aktionen, zu denen deine Agenten dich fragen, und jede Wahl, die du getroffen hast.",
    "confirm.listFailed": "Deine Bestätigungen konnten nicht geladen werden.",
    "confirm.saveFailed": "Deine Wahl wurde nicht gespeichert. Versuch es noch einmal.",
    "confirm.valueFor": "Wenn deine Agenten {action} aufrufen",
    "confirm.lockedByAdmin": "Dein Administrator entscheidet, ob hier vorher gefragt wird.",
    "confirm.notReversible":
      "Immer erlauben ist nicht verfügbar: Diese Aktion lässt sich nicht einfach rückgängig machen.",
    "confirm.gone": "Diese Aktion gibt es nicht mehr."
  }
});
