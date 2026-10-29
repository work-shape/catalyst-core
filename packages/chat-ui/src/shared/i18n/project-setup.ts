import { defineTranslations } from "./translation-area";

/**
 * A project's default agent and skills (PRJ-7): the tile on the project's page, the panel that
 * sets them, and the agent chooser of the composer that starts a chat in the project.
 */
export const projectSetup = defineTranslations({
  en: {
    "projectSetup.title": "Skills & agent",
    "projectSetup.tileSkills": "{count} skills",
    "projectSetup.tileOneSkill": "1 skill",
    "projectSetup.tileUnavailable": "Something here no longer applies",
    "projectSetup.panelLead":
      "A new chat in {project} starts with this agent; it can still be changed in the chat. Every chat in the project is offered these skills besides its agent's own.",
    "projectSetup.agentField": "Default agent",
    "projectSetup.agentHint": "Without one, a new chat starts with the workspace's agent.",
    "projectSetup.workspaceDefault": "The workspace's agent",
    "projectSetup.workspaceDefaultIs": "Now {agent}",
    "projectSetup.chooseAgent": "Choose an agent",
    "projectSetup.skillsField": "Skills",
    "projectSetup.skillsHint": "Up to {max}. A skill adds a how-to, no tools.",
    "projectSetup.chooseSkills": "Add skills",
    "projectSetup.noSkills": "No skills attached.",
    "projectSetup.ownInSharedProject":
      "Only you can use it, and the project is read by its workspace.",
    "projectSetup.ownHint": "Only you: a chat that uses it stays yours alone.",
    "projectSetup.agentUnavailable":
      "The default agent {agent} is not available here any more. New chats start with the workspace's agent.",
    "projectSetup.skillsUnavailable":
      "Not offered in this project any more: {skills}. Remove them or share them with the workspace.",
    "projectSetup.unavailableChip": "{name} · does not apply",
    "projectSetup.save": "Save",
    "projectSetup.cancel": "Cancel",
    "projectSetup.saved": "Saved.",
    "projectSetup.saveFailed": "Could not save. Try again.",
    "projectSetup.refused": "A choice cannot be used in this project. Remove it and save again.",
    "projectSetup.changedMeanwhile":
      "Someone changed the project meanwhile. Close the panel and open it again.",
    "projectSetup.loadFailed": "Could not read the project's skills and agent."
  },
  de: {
    "projectSetup.title": "Skills & Agent",
    "projectSetup.tileSkills": "{count} Skills",
    "projectSetup.tileOneSkill": "1 Skill",
    "projectSetup.tileUnavailable": "Etwas davon gilt nicht mehr",
    "projectSetup.panelLead":
      "Ein neuer Chat in {project} startet mit diesem Agenten; im Chat lässt er sich noch wechseln. Jedem Chat im Projekt stehen diese Skills zusätzlich zu denen seines Agenten zur Verfügung.",
    "projectSetup.agentField": "Standard-Agent",
    "projectSetup.agentHint": "Ohne einen startet ein neuer Chat mit dem Agenten des Workspace.",
    "projectSetup.workspaceDefault": "Agent des Workspace",
    "projectSetup.workspaceDefaultIs": "Derzeit {agent}",
    "projectSetup.chooseAgent": "Agent wählen",
    "projectSetup.skillsField": "Skills",
    "projectSetup.skillsHint":
      "Bis zu {max}. Ein Skill bringt eine Anleitung mit, keine Werkzeuge.",
    "projectSetup.chooseSkills": "Skills hinzufügen",
    "projectSetup.noSkills": "Keine Skills angehängt.",
    "projectSetup.ownInSharedProject":
      "Nur du kannst ihn nutzen, und das Projekt liest der ganze Workspace.",
    "projectSetup.ownHint": "Nur du: Ein Chat, der ihn nutzt, bleibt deiner allein.",
    "projectSetup.agentUnavailable":
      "Der Standard-Agent {agent} ist hier nicht mehr verfügbar. Neue Chats starten mit dem Agenten des Workspace.",
    "projectSetup.skillsUnavailable":
      "In diesem Projekt nicht mehr verfügbar: {skills}. Entferne sie oder teile sie mit dem Workspace.",
    "projectSetup.unavailableChip": "{name} · gilt nicht",
    "projectSetup.save": "Speichern",
    "projectSetup.cancel": "Abbrechen",
    "projectSetup.saved": "Gespeichert.",
    "projectSetup.saveFailed": "Speichern fehlgeschlagen. Versuche es noch einmal.",
    "projectSetup.refused":
      "Eine Auswahl ist in diesem Projekt nicht nutzbar. Entferne sie und speichere noch einmal.",
    "projectSetup.changedMeanwhile":
      "Jemand hat das Projekt inzwischen geändert. Schließe das Panel und öffne es erneut.",
    "projectSetup.loadFailed": "Skills und Agent des Projekts ließen sich nicht lesen."
  }
});
