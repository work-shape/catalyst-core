import { defineTranslations } from "./translation-area";

export const build = defineTranslations({
  en: {
    "build.agentMissing": "There is no agent with the id {name}.",
    "build.agentsEmpty":
      "No agents yet. An agent answers in chat with its own instructions, tools and skills.",
    "build.agentsEmptyReadOnly": "No agents yet.",
    "build.agentsSearch": "Search agents",
    "build.backToList": "Back to {kind}",
    "build.cliDescription":
      "Agents and skills can also be changed with the catalyst CLI. The documentation page Config assets describes it.",
    "build.cliPushWarning":
      "A push applies to new conversations at once and can replace changes made here.",
    "build.cliTitle": "Edit with the CLI",
    "build.kindAgents": "Agents",
    "build.kindSkills": "Skills",
    "build.kinds": "Kinds in Build",
    "build.listActions": "More actions",
    "build.loadFailed": "Build could not be loaded.",
    "build.matchCount": "{count} of {total}",
    "build.leaveConfirm": "Discard changes",
    "build.leaveDescription":
      "What you changed on this page is not saved yet. Leaving discards it.",
    "build.leaveTitle": "Leave without saving?",
    "build.noKinds": "There is nothing to build on this instance yet.",
    "build.noMatch": "Nothing matches “{query}”.",
    "build.skillMissing": "There is no skill with the id {name}.",
    "build.skillsEmpty":
      "No skills yet. A skill holds instructions that an agent reads when a task calls for them.",
    "build.skillsEmptyReadOnly": "No skills yet.",
    "build.skillsSearch": "Search skills"
  },
  de: {
    "build.agentMissing": "Es gibt keinen Agenten mit der Kennung {name}.",
    "build.agentsEmpty":
      "Noch keine Agenten. Ein Agent antwortet im Chat mit eigenen Anweisungen, Werkzeugen und Skills.",
    "build.agentsEmptyReadOnly": "Noch keine Agenten.",
    "build.agentsSearch": "Agenten durchsuchen",
    "build.backToList": "Zurück zu {kind}",
    "build.cliDescription":
      "Agenten und Skills lassen sich auch mit der catalyst CLI ändern. Die Dokumentationsseite Config assets beschreibt den Weg.",
    "build.cliPushWarning":
      "Ein Push gilt sofort für neue Unterhaltungen und kann Änderungen ersetzen, die hier gemacht wurden.",
    "build.cliTitle": "Mit der CLI bearbeiten",
    "build.kindAgents": "Agenten",
    "build.kindSkills": "Skills",
    "build.kinds": "Arten in Bauen",
    "build.listActions": "Weitere Aktionen",
    "build.loadFailed": "Bauen konnte nicht geladen werden.",
    "build.matchCount": "{count} von {total}",
    "build.leaveConfirm": "Änderungen verwerfen",
    "build.leaveDescription":
      "Was Sie auf dieser Seite geändert haben, ist noch nicht gespeichert. Beim Verlassen geht es verloren.",
    "build.leaveTitle": "Ohne Speichern verlassen?",
    "build.noKinds": "Auf dieser Instanz gibt es noch nichts zu bauen.",
    "build.noMatch": "Nichts passt zu „{query}“.",
    "build.skillMissing": "Es gibt keinen Skill mit der Kennung {name}.",
    "build.skillsEmpty":
      "Noch keine Skills. Ein Skill enthält Anweisungen, die ein Agent liest, wenn eine Aufgabe sie braucht.",
    "build.skillsEmptyReadOnly": "Noch keine Skills.",
    "build.skillsSearch": "Skills durchsuchen"
  }
});
