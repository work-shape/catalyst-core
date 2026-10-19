import { rights } from "./rights";
import { defineTranslations } from "./translation-area";

export const build = defineTranslations({
  en: {
    "build.examples": "Examples to start with",
    "build.changeCount": "{count} change",
    "build.changesCount": "{count} changes",
    "build.chooseSkills": "Choose skills",
    "build.conflict":
      "Somebody saved this while you were editing. Your text is still here and nothing was overwritten. Loading the newer version replaces your text, so copy what you want to keep first.",
    "build.conflictBy":
      "{name} saved this on {time}, while you were editing. Your text is still here and nothing was overwritten. Loading the newer version replaces your text, so copy what you want to keep first.",
    "build.conflictDeletedBy":
      "{name} deleted this on {time}, while you were editing. Your text is still here, but it can no longer be saved.",
    "build.assetRefused": "You may not read this asset.",
    "build.conflictDeleted":
      "Somebody deleted this while you were editing. Your text is still here, but it can no longer be saved.",
    "build.createAvailableHidden": "Hidden until an instance admin makes it available",
    "build.createAvailableWorkspaceHint":
      "Only members of this workspace can choose it. An instance admin can make it available in more.",
    "build.copyTitle": "{title} (copy)",
    "build.copyToEdit": "Copy to edit",
    "build.createContinue": "Continue",
    "build.createAdvanced": "Advanced",
    "build.createAddress": "Address",
    "build.createAddressHint": "Made from the name. It cannot be changed later.",
    "build.createAddressHintNamespace":
      "The full address will be {id}. It cannot be changed later.",
    "build.addressTaken": "This address is taken. Choose another name or address.",
    "build.addressInvalid":
      "This address does not work. Use lowercase letters and digits in words joined by -, starting with a letter, at most {max} characters.",
    "build.createNamespace": "Namespace",
    "build.createPurpose": "What should it do?",
    "build.createNoNamespace": "No Namespace",
    "build.defaultModel": "Default model",
    "build.modelSetByModelManagers": `Only people who may ${rights.en["rights.actionAgentModelsManage"].toLowerCase()} can change these.`,
    "build.reasoningEffortHint":
      "Reasoning effort is how long the model thinks before it answers; more helps with hard questions but takes longer.",
    "build.discard": "Discard",
    "build.fallbackEnglish": "Empty in this language. People read the English text.",
    "build.fallbackGerman": "Empty in this language. People read the German text.",
    "build.history": "History",
    "build.draftAhead": "Draft",
    "build.neverPublished": "Not published",
    "build.publish": "Publish",
    "build.savesDraft": "Saves a draft. It answers nobody until it is published.",
    "build.publishTitle": "Publish {name}?",
    "build.publishDescription":
      "The saved draft becomes the version everyone who uses it gets, from now on. Unsaved changes are not part of it.",
    "build.publishFailed": "The draft could not be published.",
    "build.deleteFailed": "It could not be deleted. Try again.",
    "build.refusedDataStoreInUse":
      "This data store is still in use, so nothing was deleted. Stop using it in the apps, workflows, agents and knowledge bases that use it, then delete it.",
    "build.deleteChanged":
      "Somebody changed this since you opened it, so nothing was deleted. Open the page again to see the newer version.",
    "build.editWithAgent": "Edit with the agent",
    "build.editWithAgentFailed": "The agent could not be opened",
    "build.editWithAgentRefused": "You can no longer open this, or it is gone.",
    "build.editWithAgentClose": "Close",
    "build.publishSaveFirst": "Save your changes first: only a saved draft can be published.",
    "build.historyDescription": "Every saved revision of {name}, the newest first.",
    "build.historyStale":
      "This page holds an older version. Load the newer version before you restore one.",
    "build.loadNewer": "Load the newer version",
    "build.loadNewerDescription": "Changes on this page that are not saved are lost.",
    "build.loadNewerFailed":
      "The newer version could not be loaded. Your text is still here. Try again in a moment.",
    "build.loadNewerTitle": "Load the newer version?",
    "build.nameDeleted":
      "An asset with the id {name} was deleted, and you may not read its history. Go back and choose another one.",
    "build.nameTaken": "The id {name} is taken. Go back and choose another one.",
    "build.openHistory": "Open history",
    "build.namespaceAll": "All Namespaces",
    "build.scopeFilter": "Scope",
    "build.scopeInstance": "Instance",
    "build.scopePersonal": "Personal",
    "build.namespaceFilter": "Namespace",
    "build.noAccess":
      "Studio is not available to you. It opens for people who hold a right on an agent or a skill.",
    "build.noMatchInNamespace": "Nothing in this Namespace.",
    "build.noneInScope": "Nothing in {scope} yet.",
    "build.noSkillsChosen": "No skills chosen.",
    "build.platform": "Platform",
    "build.pendingApproval":
      "This change waits for an approval. Nothing was changed yet and your text is still here.",
    "build.pendingApprovalBy":
      "This change waits for approval by {names}. Nothing has changed yet and your text is still here.",
    "build.readOnly": "You can read this but not change it.",
    "build.saveWaits": "Saving sends a request. It takes effect only once it is approved.",
    "build.saveWaitsFor": "Saving sends a request. It takes effect once {names} approves it.",
    "build.readOnlyInstance":
      "Belongs to no Namespace. Only a person who may edit on the whole instance can change it.",
    "build.readOnlyNamespace":
      "Belongs to the Namespace {namespace}. Only a person who may edit in this Namespace can change it.",
    "build.readOnlyWorkspace":
      "Belongs to the workspace {workspace}. Only a person who may edit in this workspace can change it.",
    "build.readOnlyPlatform":
      "Ships with the platform and is updated with each release. To change it, copy it and edit the copy.",
    "build.restored": "Revision {number} restored.",
    "build.refusedModel": "The model {model} is not allowed in Namespace {namespace}.",
    "build.refusedModelRequired":
      "An agent in Namespace {namespace} needs a default model the Namespace allows.",
    "build.refusedTool": "The tool {tool} is not allowed in Namespace {namespace}.",
    "build.refusedEgress":
      "The operator's network rule blocks this destination. To have it allowed, send the operator the host of the address.",
    "build.refusedReadOnlyOrigin":
      "The operator of the instance set up this connection, so it cannot be changed here.",
    "build.refusedDependencyReview":
      "Where this agent will be available changed after you checked what it uses. Nothing was created. Create it again to check the list once more.",
    "build.dependencyCheckFailed":
      "Could not check what this agent uses where it will be available. Nothing was created. Try again.",
    "build.removePrompt": "Remove prompt {number}",
    "build.restoreDescription":
      "The asset gets a new revision with that content. Changes on this page that are not saved are lost.",
    "build.restoreRevision": "Restore revision {number}",
    "build.restoreTitle": "Restore revision {number}?",
    "build.revisionNumber": "Revision {number}",
    "build.sectionModel": "Model",
    "build.sectionOverview": "Overview",
    "build.selectableModels": "Models people can choose in chat",
    "build.showMore": "Show more",
    "build.skillFiles": "Files of the skill",
    "build.textsIn": "Texts in",
    "build.textMissing": "1 text is empty in this language",
    "build.textsMissing": "{count} texts are empty in this language",
    "build.agentMissing": "There is no agent at this address.",
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
    "build.identifier": "ID",
    "build.kindAgents": "Agents",
    "build.kindSkills": "Skills",
    "build.kinds": "Kinds in Studio",
    "build.loadFailed": "Studio could not be loaded.",
    "build.leaveConfirm": "Discard changes",
    "build.leaveDescription":
      "What you changed on this page is not saved yet. Leaving discards it.",
    "build.leaveTitle": "Leave without saving?",
    "build.noKinds": "There is nothing to build on this instance yet.",
    "build.noMatch": "Nothing matches “{query}”.",
    "build.skillMissing": "There is no skill with the id {name}.",
    "build.skillSummary": "Summary",
    "build.skillSummaryHint":
      "One sentence for people that says what an agent with this skill knows how to do. Lists show it under the title.",
    "build.skillSummaryPlaceholder": "Knows how to write short, easy sentences.",
    "build.skillsEmpty":
      "No skills yet. A skill holds instructions that an agent reads when a task calls for them.",
    "build.skillsEmptyReadOnly": "No skills yet.",
    "build.skillsNote": "A skill is instructions the agent follows. It adds no tools.",
    "build.skillsSearch": "Search skills"
  },
  de: {
    "build.examples": "Beispiele für den Einstieg",
    "build.changeCount": "{count} Änderung",
    "build.changesCount": "{count} Änderungen",
    "build.chooseSkills": "Skills auswählen",
    "build.conflict":
      "Jemand hat dies gespeichert, während du es bearbeitet hast. Dein Text ist noch da und nichts wurde überschrieben. Die neuere Version zu laden ersetzt deinen Text. Kopiere vorher, was du behalten willst.",
    "build.conflictBy":
      "{name} hat dies am {time} gespeichert, während du es bearbeitet hast. Dein Text ist noch da und nichts wurde überschrieben. Die neuere Version zu laden ersetzt deinen Text. Kopiere vorher, was du behalten willst.",
    "build.conflictDeletedBy":
      "{name} hat dies am {time} gelöscht, während du es bearbeitet hast. Dein Text steht noch hier, lässt sich aber nicht mehr speichern.",
    "build.assetRefused": "Du darfst dieses Asset nicht lesen.",
    "build.conflictDeleted":
      "Jemand hat dies gelöscht, während du es bearbeitet hast. Dein Text steht noch hier, lässt sich aber nicht mehr speichern.",
    "build.createAvailableHidden": "Ausgeblendet, bis ein Instanz-Admin ihn verfügbar macht",
    "build.createAvailableWorkspaceHint":
      "Nur Mitglieder dieses Arbeitsbereichs können ihn auswählen. Ein Instanz-Admin kann ihn in weiteren verfügbar machen.",
    "build.copyTitle": "{title} (Kopie)",
    "build.copyToEdit": "Zum Bearbeiten kopieren",
    "build.createContinue": "Weiter",
    "build.createAdvanced": "Erweitert",
    "build.createAddress": "Adresse",
    "build.createAddressHint": "Aus dem Namen gebildet. Sie lässt sich später nicht ändern.",
    "build.createAddressHintNamespace":
      "Die vollständige Adresse lautet {id}. Sie lässt sich später nicht ändern.",
    "build.addressTaken":
      "Diese Adresse ist vergeben. Wähle einen anderen Namen oder eine andere Adresse.",
    "build.addressInvalid":
      "Diese Adresse geht so nicht. Nimm Kleinbuchstaben und Ziffern in Wörtern, die - verbindet, am Anfang einen Buchstaben, höchstens {max} Zeichen.",
    "build.createNamespace": "Namespace",
    "build.createPurpose": "Was soll er tun?",
    "build.createNoNamespace": "Kein Namespace",
    "build.defaultModel": "Standardmodell",
    "build.modelSetByModelManagers": `Ändern darf das nur, wer die ${rights.de["rights.actionAgentModelsManage"]} darf.`,
    "build.reasoningEffortHint":
      "Der Denkaufwand bestimmt, wie lange das Modell vor der Antwort nachdenkt; mehr hilft bei schwierigen Fragen, dauert aber länger.",
    "build.discard": "Verwerfen",
    "build.fallbackEnglish": "In dieser Sprache leer. Es wird der englische Text gezeigt.",
    "build.fallbackGerman": "In dieser Sprache leer. Es wird der deutsche Text gezeigt.",
    "build.history": "Verlauf",
    "build.draftAhead": "Entwurf",
    "build.neverPublished": "Nicht veröffentlicht",
    "build.publish": "Veröffentlichen",
    "build.savesDraft":
      "Speichert einen Entwurf. Er antwortet niemandem, bis er veröffentlicht ist.",
    "build.publishTitle": "{name} veröffentlichen?",
    "build.publishDescription":
      "Der gespeicherte Entwurf wird ab jetzt die Version, die alle bekommen, die damit arbeiten. Ungespeicherte Änderungen gehören nicht dazu.",
    "build.publishFailed": "Der Entwurf konnte nicht veröffentlicht werden.",
    "build.deleteFailed": "Das ließ sich nicht löschen. Versuch es noch einmal.",
    "build.refusedDataStoreInUse":
      "Dieser Datenspeicher wird noch verwendet, daher wurde nichts gelöscht. Entferne ihn aus den Apps, Workflows, Agenten und Wissensbasen, die ihn verwenden, und lösche ihn dann.",
    "build.deleteChanged":
      "Jemand hat dies geändert, seit du es geöffnet hast. Darum wurde nichts gelöscht. Öffne die Seite neu, um die neuere Version zu sehen.",
    "build.editWithAgent": "Mit dem Agenten bearbeiten",
    "build.editWithAgentFailed": "Der Agent ließ sich nicht öffnen",
    "build.editWithAgentRefused": "Du kannst dies nicht mehr öffnen, oder es ist weg.",
    "build.editWithAgentClose": "Schließen",
    "build.publishSaveFirst":
      "Speichere zuerst deine Änderungen: Nur ein gespeicherter Entwurf lässt sich veröffentlichen.",
    "build.historyDescription": "Jede gespeicherte Version von {name}, die neueste zuerst.",
    "build.historyStale":
      "Diese Seite zeigt eine ältere Version. Lade die neuere Version, bevor du eine wiederherstellst.",
    "build.loadNewer": "Neuere Version laden",
    "build.loadNewerDescription": "Ungespeicherte Änderungen auf dieser Seite gehen verloren.",
    "build.loadNewerFailed":
      "Die neuere Version konnte nicht geladen werden. Dein Text steht noch hier. Versuch es gleich noch einmal.",
    "build.loadNewerTitle": "Neuere Version laden?",
    "build.nameDeleted":
      "Ein Asset mit der Kennung {name} wurde gelöscht, und du darfst seinen Verlauf nicht lesen. Geh zurück und wähle eine andere.",
    "build.nameTaken": "Die Kennung {name} ist vergeben. Geh zurück und wähle eine andere.",
    "build.openHistory": "Verlauf öffnen",
    "build.namespaceAll": "Alle Namespaces",
    "build.scopeFilter": "Geltungsbereich",
    "build.scopeInstance": "Instanz",
    "build.scopePersonal": "Persönlich",
    "build.namespaceFilter": "Namespace",
    "build.noAccess":
      "Studio steht dir nicht zur Verfügung. Es öffnet sich für Personen mit einem Recht an einem Agenten oder einem Skill.",
    "build.noMatchInNamespace": "Nichts in diesem Namespace.",
    "build.noneInScope": "Noch nichts in {scope}.",
    "build.noSkillsChosen": "Keine Skills ausgewählt.",
    "build.platform": "Plattform",
    "build.pendingApproval":
      "Diese Änderung wartet auf eine Freigabe. Es wurde noch nichts geändert und dein Text ist noch da.",
    "build.pendingApprovalBy":
      "Diese Änderung wartet auf Freigabe durch {names}. Es wurde noch nichts geändert und dein Text ist noch da.",
    "build.readOnly": "Du kannst dies lesen, aber nicht ändern.",
    "build.saveWaits": "Speichern schickt eine Anfrage. Wirksam wird sie erst nach einer Freigabe.",
    "build.saveWaitsFor":
      "Speichern schickt eine Anfrage. Wirksam wird sie erst nach Freigabe durch {names}.",
    "build.readOnlyInstance":
      "Gehört zu keinem Namespace. Ändern kann es nur, wer in der ganzen Instanz bearbeiten darf.",
    "build.readOnlyNamespace":
      "Gehört zum Namespace {namespace}. Ändern kann es nur, wer in diesem Namespace bearbeiten darf.",
    "build.readOnlyWorkspace":
      "Gehört zum Arbeitsbereich {workspace}. Ändern kann es nur, wer in diesem Arbeitsbereich bearbeiten darf.",
    "build.readOnlyPlatform":
      "Kommt mit der Plattform und wird mit jedem Release aktualisiert. Um es zu ändern, kopiere es und bearbeite die Kopie.",
    "build.restored": "Version {number} wiederhergestellt.",
    "build.refusedModel": "Das Modell {model} ist im Namespace {namespace} nicht erlaubt.",
    "build.refusedModelRequired":
      "Ein Agent im Namespace {namespace} braucht ein Standardmodell, das der Namespace erlaubt.",
    "build.refusedTool": "Das Werkzeug {tool} ist im Namespace {namespace} nicht erlaubt.",
    "build.refusedEgress":
      "Eine Netzwerkregel des Betreibers sperrt dieses Ziel. Damit es erlaubt wird, schick dem Betreiber den Host der Adresse.",
    "build.refusedReadOnlyOrigin":
      "Diese Verbindung hat der Betreiber der Instanz eingerichtet, deshalb lässt sie sich hier nicht ändern.",
    "build.refusedDependencyReview":
      "Wo dieser Agent verfügbar sein wird, hat sich nach deiner Prüfung geändert. Es wurde nichts erstellt. Erstelle ihn noch einmal, um die Liste erneut zu prüfen.",
    "build.dependencyCheckFailed":
      "Es ließ sich nicht prüfen, was dieser Agent dort verwendet, wo er verfügbar sein wird. Es wurde nichts erstellt. Versuch es noch einmal.",
    "build.removePrompt": "Vorschlag {number} entfernen",
    "build.restoreDescription":
      "Das Asset erhält eine neue Version mit diesem Inhalt. Nicht gespeicherte Änderungen auf dieser Seite gehen verloren.",
    "build.restoreRevision": "Version {number} wiederherstellen",
    "build.restoreTitle": "Version {number} wiederherstellen?",
    "build.revisionNumber": "Version {number}",
    "build.sectionModel": "Modell",
    "build.sectionOverview": "Überblick",
    "build.selectableModels": "Modelle, die im Chat wählbar sind",
    "build.showMore": "Mehr anzeigen",
    "build.skillFiles": "Dateien des Skills",
    "build.textsIn": "Texte in",
    "build.textMissing": "1 Text ist in dieser Sprache leer",
    "build.textsMissing": "{count} Texte sind in dieser Sprache leer",
    "build.agentMissing": "Unter dieser Adresse gibt es keinen Agenten.",
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
    "build.identifier": "ID",
    "build.kindAgents": "Agenten",
    "build.kindSkills": "Skills",
    "build.kinds": "Arten im Studio",
    "build.loadFailed": "Studio konnte nicht geladen werden.",
    "build.leaveConfirm": "Änderungen verwerfen",
    "build.leaveDescription":
      "Was du auf dieser Seite geändert hast, ist noch nicht gespeichert. Beim Verlassen geht es verloren.",
    "build.leaveTitle": "Ohne Speichern verlassen?",
    "build.noKinds": "Auf dieser Instanz gibt es noch nichts zu bauen.",
    "build.noMatch": "Nichts passt zu „{query}“.",
    "build.skillMissing": "Es gibt keinen Skill mit der Kennung {name}.",
    "build.skillSummary": "Kurzbeschreibung",
    "build.skillSummaryHint":
      "Ein Satz für Menschen, der sagt, was ein Agent mit diesem Skill kann. Listen zeigen ihn unter dem Titel.",
    "build.skillSummaryPlaceholder": "Weiß, wie man kurze, einfache Sätze schreibt.",
    "build.skillsEmpty":
      "Noch keine Skills. Ein Skill enthält Anweisungen, die ein Agent liest, wenn eine Aufgabe sie braucht.",
    "build.skillsEmptyReadOnly": "Noch keine Skills.",
    "build.skillsNote":
      "Ein Skill ist eine Anleitung, der der Agent folgt. Er bringt keine Werkzeuge mit.",
    "build.skillsSearch": "Skills durchsuchen"
  }
});
