import { defineTranslations } from "./translation-area";

/**
 * The change proposal on an agent's page: what the agent in the dock proposes for the agent,
 * marked at each field, with Apply and Discard.
 */
export const agentProposal = defineTranslations({
  en: {
    "agentProposal.adds": "Adds {names}",
    "agentProposal.apply": "Apply",
    "agentProposal.changed": "The agent changed its proposal while you were looking at it.",
    "agentProposal.discard": "Discard proposal",
    "agentProposal.empty": "Empty",
    "agentProposal.failed": "That did not work. Try again.",
    "agentProposal.label": "Proposed by the agent",
    "agentProposal.modelSettings": "Changes the settings of the models people may choose",
    "agentProposal.off": "Off",
    "agentProposal.on": "On",
    "agentProposal.pending":
      "The agent proposes changes to {count} fields. They are marked below. If you apply them, they take effect at once for everyone who uses “{name}”.",
    "agentProposal.pendingOne":
      "The agent proposes a change to one field. It is marked below. If you apply it, it takes effect at once for everyone who uses “{name}”.",
    "agentProposal.pendingReader":
      "The agent proposes changes to {count} fields. They are marked below. Someone who may change this agent can apply them.",
    "agentProposal.pendingReaderOne":
      "The agent proposes a change to one field. It is marked below. Someone who may change this agent can apply it.",
    "agentProposal.removes": "Removes {names}",
    "agentProposal.saveFirst": "Save or discard your own changes first.",
    "agentProposal.sectionMark": "Proposed change",
    "agentProposal.stale":
      "This proposal can no longer be applied. Ask the agent in the chat to make the change again."
  },
  de: {
    "agentProposal.adds": "Fügt {names} hinzu",
    "agentProposal.apply": "Übernehmen",
    "agentProposal.changed":
      "Der Agent hat seinen Vorschlag geändert, während du ihn angesehen hast.",
    "agentProposal.discard": "Vorschlag verwerfen",
    "agentProposal.empty": "Leer",
    "agentProposal.failed": "Das hat nicht geklappt. Versuch es noch einmal.",
    "agentProposal.label": "Vom Agenten vorgeschlagen",
    "agentProposal.modelSettings": "Ändert die Einstellungen der Modelle, die man wählen kann",
    "agentProposal.off": "Aus",
    "agentProposal.on": "An",
    "agentProposal.pending":
      "Der Agent schlägt Änderungen an {count} Feldern vor. Sie sind unten markiert. Übernimmst du sie, gelten sie sofort für alle, die „{name}“ nutzen.",
    "agentProposal.pendingOne":
      "Der Agent schlägt eine Änderung an einem Feld vor. Sie ist unten markiert. Übernimmst du sie, gilt sie sofort für alle, die „{name}“ nutzen.",
    "agentProposal.pendingReader":
      "Der Agent schlägt Änderungen an {count} Feldern vor. Sie sind unten markiert. Übernehmen kann sie, wer diesen Agenten ändern darf.",
    "agentProposal.pendingReaderOne":
      "Der Agent schlägt eine Änderung an einem Feld vor. Sie ist unten markiert. Übernehmen kann sie, wer diesen Agenten ändern darf.",
    "agentProposal.removes": "Entfernt {names}",
    "agentProposal.saveFirst": "Speichere oder verwirf zuerst deine eigenen Änderungen.",
    "agentProposal.sectionMark": "Vorgeschlagene Änderung",
    "agentProposal.stale":
      "Dieser Vorschlag lässt sich nicht mehr übernehmen. Bitte den Agenten im Chat, die Änderung noch einmal vorzuschlagen."
  }
});
