import { defineTranslations } from "./translation-area";

// The catalogue in New connection (CAT-1): the "Dienste" group of entry cards and the steps
// that install one part of an entry. `{title}` is the entry's name, such as a service's.
export const connectionCatalogue = defineTranslations({
  en: {
    "connectionCatalogue.services": "Services",
    "connectionCatalogue.own": "Your own connection",
    "connectionCatalogue.partTools": "For agents",
    "connectionCatalogue.partSource": "As a Knowledge Base source",
    "connectionCatalogue.notOffered": "Ask your operator",
    "connectionCatalogue.partChoice": "What to connect",
    "connectionCatalogue.examples": "Ask, for example",
    "connectionCatalogue.checklist": "Before you connect",
    "connectionCatalogue.hosts": "Reaches {hosts}.",
    "connectionCatalogue.reviewIntro":
      "{title} recommends the ticked reading tools. None is enabled until you approve.",
    "connectionCatalogue.connected": "{name} is connected."
  },
  de: {
    "connectionCatalogue.services": "Dienste",
    "connectionCatalogue.own": "Eigene Verbindung",
    "connectionCatalogue.partTools": "Für Agenten",
    "connectionCatalogue.partSource": "Als Quelle einer Wissensdatenbank",
    "connectionCatalogue.notOffered": "Frag deinen Betreiber",
    "connectionCatalogue.partChoice": "Was du verbindest",
    "connectionCatalogue.examples": "Frag zum Beispiel",
    "connectionCatalogue.checklist": "Vor dem Verbinden",
    "connectionCatalogue.hosts": "Erreicht {hosts}.",
    "connectionCatalogue.reviewIntro":
      "{title} empfiehlt die angehakten Lese-Tools. Freigegeben ist keines, bis du bestätigst.",
    "connectionCatalogue.connected": "{name} ist verbunden."
  }
});
