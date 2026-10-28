import { defineTranslations } from "./translation-area";

/**
 * The publish question's lead (PUBQ-1): the instance's sentence on what a publish makes live
 * comes first, its warnings before the click, and the lists behind "Details".
 */
export const publishNarrative = defineTranslations({
  en: {
    "publishNarrative.details": "Details",
    "publishNarrative.warnings": "Before you publish",
    "publishNarrative.loading": "Reading what this publish makes live…",
    "publishNarrative.failed":
      "Could not read what this publish makes live. Try again before you publish.",
    "publishNarrative.malformed":
      "The description of this publish could not be read whole, so it cannot be published from here. Ask an admin."
  },
  de: {
    "publishNarrative.details": "Details",
    "publishNarrative.warnings": "Bevor du veröffentlichst",
    "publishNarrative.loading": "Es wird gelesen, was diese Veröffentlichung live schaltet…",
    "publishNarrative.failed":
      "Es konnte nicht gelesen werden, was diese Veröffentlichung live schaltet. Versuche es erneut, bevor du veröffentlichst.",
    "publishNarrative.malformed":
      "Die Beschreibung dieser Veröffentlichung konnte nicht vollständig gelesen werden, deshalb kann sie hier nicht veröffentlicht werden. Bitte einen Admin um Hilfe."
  }
});
