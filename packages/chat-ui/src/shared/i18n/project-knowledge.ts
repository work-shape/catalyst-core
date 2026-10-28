import { defineTranslations } from "./translation-area";

/**
 * A project's Knowledge Bases (PRJ-8): the tile on the project's page and the panel that attaches
 * them. Every chat in the project searches them beside its agent's own.
 */
export const projectKnowledge = defineTranslations({
  en: {
    "projectKnowledge.title": "Knowledge Bases",
    "projectKnowledge.tileEmpty": "None. Chats search their agent's Knowledge Bases only.",
    "projectKnowledge.tileUnavailable": "Something here no longer applies",
    "projectKnowledge.open": "Open Knowledge Bases",
    "projectKnowledge.panelLead":
      "Every chat in {project} searches these Knowledge Bases besides its agent's own. Attaching gives nobody a right: each search checks that the person may use the Knowledge Base.",
    "projectKnowledge.field": "Attached Knowledge Bases",
    "projectKnowledge.hint":
      "Up to {max}. Only those everyone who reads the project may use can be attached.",
    "projectKnowledge.choose": "Add Knowledge Bases",
    "projectKnowledge.none": "No Knowledge Bases attached.",
    "projectKnowledge.ownInSharedProject":
      "Only you can use it, and the project is read by its workspace.",
    "projectKnowledge.notEveryone": "Not everyone in {team} may use it.",
    "projectKnowledge.ownHint": "Only you: it answers in your own chats here.",
    "projectKnowledge.unpublished": "Not published yet",
    "projectKnowledge.unavailable":
      "Not searched in this project any more: {names}. Everyone who reads the project must be able to use them. Remove them, or make them available in the workspace.",
    "projectKnowledge.unavailableChip": "{name} · does not apply",
    "projectKnowledge.loadFailed": "Could not read the project's Knowledge Bases."
  },
  de: {
    "projectKnowledge.title": "Wissensbasen",
    "projectKnowledge.tileEmpty": "Keine. Chats durchsuchen nur die Wissensbasen ihres Agenten.",
    "projectKnowledge.tileUnavailable": "Etwas davon gilt nicht mehr",
    "projectKnowledge.open": "Wissensbasen öffnen",
    "projectKnowledge.panelLead":
      "Jeder Chat in {project} durchsucht diese Wissensbasen zusätzlich zu denen seines Agenten. Anhängen gibt niemandem ein Recht: Jede Suche prüft, ob die Person die Wissensbasis nutzen darf.",
    "projectKnowledge.field": "Angehängte Wissensbasen",
    "projectKnowledge.hint":
      "Bis zu {max}. Anhängen lassen sich nur die, die alle nutzen dürfen, die das Projekt lesen.",
    "projectKnowledge.choose": "Wissensbasen hinzufügen",
    "projectKnowledge.none": "Keine Wissensbasen angehängt.",
    "projectKnowledge.ownInSharedProject":
      "Nur du kannst sie nutzen, und das Projekt liest der ganze Workspace.",
    "projectKnowledge.notEveryone": "Nicht alle in {team} dürfen sie nutzen.",
    "projectKnowledge.ownHint": "Nur du: Sie antwortet hier in deinen eigenen Chats.",
    "projectKnowledge.unpublished": "Noch nicht veröffentlicht",
    "projectKnowledge.unavailable":
      "In diesem Projekt nicht mehr durchsucht: {names}. Alle, die das Projekt lesen, müssen sie nutzen dürfen. Entferne sie oder mach sie im Workspace verfügbar.",
    "projectKnowledge.unavailableChip": "{name} · gilt nicht",
    "projectKnowledge.loadFailed": "Die Wissensbasen des Projekts ließen sich nicht lesen."
  }
});
