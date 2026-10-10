import { defineTranslations } from "./translation-area";

export const build = defineTranslations({
  en: {
    "build.assetActions": "More actions",
    "build.changeCount": "{count} change",
    "build.changesCount": "{count} changes",
    "build.chooseSkills": "Choose skills",
    "build.conflict":
      "Somebody saved this while you were editing. Your text is still here and nothing was overwritten.",
    "build.assetRefused": "You may not read this asset.",
    "build.conflictDeleted":
      "Somebody deleted this while you were editing. Your text is still here, but it can no longer be saved.",
    "build.createContinue": "Continue",
    "build.createId": "Id",
    "build.createIdHint":
      "Lowercase letters, digits, underscores and hyphens. It cannot be changed later.",
    "build.createIdHintNamespace": "The full id will be {id}. It cannot be changed later.",
    "build.createNamespace": "Namespace",
    "build.createNamespaceHint": "The id starts with the prefix of the Namespace.",
    "build.createNoNamespace": "No Namespace",
    "build.defaultModel": "Default model",
    "build.discard": "Discard",
    "build.fallbackEnglish": "Empty in this language. People read the English text.",
    "build.fallbackGerman": "Empty in this language. People read the German text.",
    "build.history": "History",
    "build.historyDescription": "Every saved revision of {name}, the newest first.",
    "build.historyStale":
      "This page holds an older version. Load the newer version before you restore one.",
    "build.loadNewer": "Load the newer version",
    "build.loadNewerDescription": "Changes on this page that are not saved are lost.",
    "build.loadNewerFailed":
      "The newer version could not be loaded. Your text is still here. Try again in a moment.",
    "build.loadNewerTitle": "Load the newer version?",
    "build.nameTaken": "The id {name} is taken. Go back and choose another one.",
    "build.namespaceAll": "All Namespaces",
    "build.namespaceFilter": "Namespace",
    "build.noAccess":
      "Build is not available to you. It opens for people who hold a right on an agent or a skill.",
    "build.noMatchInNamespace": "Nothing in this Namespace.",
    "build.noSkillsChosen": "No skills chosen.",
    "build.pendingApproval":
      "This change waits for an approval. Nothing was changed yet and your text is still here.",
    "build.readOnly": "You can read this but not change it.",
    "build.readOnlyInstance": "Instance asset. Editing needs Builder on the instance.",
    "build.readOnlyNamespace":
      "Asset of Namespace {namespace}. Editing needs Builder in this Namespace.",
    "build.restored": "Revision {number} restored.",
    "build.refusedModel": "The model {model} is not allowed in Namespace {namespace}.",
    "build.refusedModelRequired":
      "An agent in Namespace {namespace} needs a default model the Namespace allows.",
    "build.refusedTool": "The tool {tool} is not allowed in Namespace {namespace}.",
    "build.removePrompt": "Remove prompt {number}",
    "build.restoreDescription":
      "The asset gets a new revision with that content. Changes on this page that are not saved are lost.",
    "build.restoreRevision": "Restore revision {number}",
    "build.restoreTitle": "Restore revision {number}?",
    "build.revisionNumber": "Revision {number}",
    "build.sectionModel": "Model",
    "build.sectionOverview": "Overview",
    "build.sections": "Sections of this page",
    "build.selectableModels": "Models people can choose in chat",
    "build.showMore": "Show more",
    "build.skillFiles": "Files of the skill",
    "build.textsIn": "Texts in",
    "build.textMissing": "1 text is empty in this language",
    "build.textsMissing": "{count} texts are empty in this language",
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
    "build.assetActions": "Weitere Aktionen",
    "build.changeCount": "{count} Änderung",
    "build.changesCount": "{count} Änderungen",
    "build.chooseSkills": "Skills auswählen",
    "build.conflict":
      "Jemand hat dies gespeichert, während Sie es bearbeitet haben. Ihr Text ist noch da und nichts wurde überschrieben.",
    "build.assetRefused": "Sie dürfen dieses Asset nicht lesen.",
    "build.conflictDeleted":
      "Jemand hat dies gelöscht, während Sie es bearbeitet haben. Ihr Text steht noch hier, lässt sich aber nicht mehr speichern.",
    "build.createContinue": "Weiter",
    "build.createId": "Kennung",
    "build.createIdHint":
      "Kleinbuchstaben, Ziffern, Unterstriche und Bindestriche. Sie lässt sich später nicht ändern.",
    "build.createIdHintNamespace":
      "Die vollständige Kennung lautet {id}. Sie lässt sich später nicht ändern.",
    "build.createNamespace": "Namespace",
    "build.createNamespaceHint": "Die Kennung beginnt mit dem Präfix des Namespace.",
    "build.createNoNamespace": "Kein Namespace",
    "build.defaultModel": "Standardmodell",
    "build.discard": "Verwerfen",
    "build.fallbackEnglish": "In dieser Sprache leer. Es wird der englische Text gezeigt.",
    "build.fallbackGerman": "In dieser Sprache leer. Es wird der deutsche Text gezeigt.",
    "build.history": "Verlauf",
    "build.historyDescription": "Jede gespeicherte Version von {name}, die neueste zuerst.",
    "build.historyStale":
      "Diese Seite zeigt eine ältere Version. Laden Sie die neuere Version, bevor Sie eine wiederherstellen.",
    "build.loadNewer": "Neuere Version laden",
    "build.loadNewerDescription": "Ungespeicherte Änderungen auf dieser Seite gehen verloren.",
    "build.loadNewerFailed":
      "Die neuere Version konnte nicht geladen werden. Ihr Text steht noch hier. Versuchen Sie es gleich noch einmal.",
    "build.loadNewerTitle": "Neuere Version laden?",
    "build.nameTaken":
      "Die Kennung {name} ist vergeben. Gehen Sie zurück und wählen Sie eine andere.",
    "build.namespaceAll": "Alle Namespaces",
    "build.namespaceFilter": "Namespace",
    "build.noAccess":
      "Bauen steht Ihnen nicht zur Verfügung. Es öffnet sich für Personen mit einem Recht an einem Agenten oder einem Skill.",
    "build.noMatchInNamespace": "Nichts in diesem Namespace.",
    "build.noSkillsChosen": "Keine Skills ausgewählt.",
    "build.pendingApproval":
      "Diese Änderung wartet auf eine Freigabe. Es wurde noch nichts geändert und Ihr Text ist noch da.",
    "build.readOnly": "Sie können dies lesen, aber nicht ändern.",
    "build.readOnlyInstance": "Instanz-Asset. Zum Bearbeiten braucht es Builder auf Instanzebene.",
    "build.readOnlyNamespace":
      "Asset des Namespace {namespace}. Zum Bearbeiten braucht es Builder in diesem Namespace.",
    "build.restored": "Version {number} wiederhergestellt.",
    "build.refusedModel": "Das Modell {model} ist im Namespace {namespace} nicht erlaubt.",
    "build.refusedModelRequired":
      "Ein Agent im Namespace {namespace} braucht ein Standardmodell, das der Namespace erlaubt.",
    "build.refusedTool": "Das Werkzeug {tool} ist im Namespace {namespace} nicht erlaubt.",
    "build.removePrompt": "Vorschlag {number} entfernen",
    "build.restoreDescription":
      "Das Asset erhält eine neue Version mit diesem Inhalt. Nicht gespeicherte Änderungen auf dieser Seite gehen verloren.",
    "build.restoreRevision": "Version {number} wiederherstellen",
    "build.restoreTitle": "Version {number} wiederherstellen?",
    "build.revisionNumber": "Version {number}",
    "build.sectionModel": "Modell",
    "build.sectionOverview": "Überblick",
    "build.sections": "Abschnitte dieser Seite",
    "build.selectableModels": "Modelle, die im Chat wählbar sind",
    "build.showMore": "Mehr anzeigen",
    "build.skillFiles": "Dateien des Skills",
    "build.textsIn": "Texte in",
    "build.textMissing": "1 Text ist in dieser Sprache leer",
    "build.textsMissing": "{count} Texte sind in dieser Sprache leer",
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
