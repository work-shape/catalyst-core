import { defineTranslations } from "./translation-area";

// Translation data stays below the registry; the reason table lives in refusals.ts.
export const refusals = defineTranslations({
  en: {
    "refusals.dataStoreBelowMinSchema":
      "The app needs a newer version of the data store “{dataStore}”. Publish it together with the app.",
    "refusals.dataStoreNeedsApp":
      "This preview reaches no data stores. To test with real data, open the app.",
    "refusals.dataStoreUnavailable": "There is no data store “{dataStore}” here (any more).",
    "refusals.dataStoreNotListed":
      "The action “{action}” uses the data store “{dataStore}”, which the app does not list. Ask the agent to add it to the app.",
    "refusals.dataStoreNamedTwice":
      "The data store “{dataStore}” is named twice. Open the dialog again.",
    "refusals.dataStoreNotReached":
      "The app does not use the data store “{dataStore}”, so it is not published with it. Open the dialog again to see what goes live.",
    "refusals.dataStoreDraftBelowMinSchema":
      "The app needs a newer version of the data store “{dataStore}” than its draft has. Ask the agent to extend the data store.",
    "refusals.dataStoreJobExhausted":
      "Creating or updating the Data Store ‘{dataStore}’ stopped and will not be retried automatically. Ask an administrator to retry the job under System > Jobs, then publish the App again.",
    "refusals.dataStoreMigrationFailed":
      "The change “{migration}” to the data store “{dataStore}” could not be applied. The app is not published.",
    "refusals.dataStoreMigrationFailedUnnamed":
      "A change to the data store “{dataStore}” could not be applied. The app is not published.",
    "refusals.dataStoreMigrating":
      "The data store “{dataStore}” is still being updated. Try again in a minute.",
    "refusals.dataHandoverNeedsOwner":
      "{readers} people who would read the data store “{dataStore}” may not use “{connection}”. Ask a person who may change “{connection}” to publish this version and confirm the hand-over, or narrow who reads the data store.",
    "refusals.dataHandoverNeedsOwnerHidden":
      "{readers} people who would read the data store “{dataStore}” may not use one of its sources. Ask a person who may change that source to publish this version and confirm the hand-over, or narrow who reads the data store.",
    "refusals.dataHandoverUnconfirmed":
      "Who would read the data store “{dataStore}” has changed since the question was shown. Open the dialog again, read who receives the data and publish again.",
    "refusals.dataStoreNotReady": "The data store is not ready yet. Try again in a moment.",
    "refusals.dataStoreKeyReused":
      "The app sent this change twice with different content. Reload the app and try again.",
    "refusals.rowsTooLarge":
      "This change is too large for one call. Split it across several calls.",
    "refusals.rowsTooMany":
      "This change holds too many entries for one call. Split it across several calls.",
    "refusals.dataStoreIdHeld":
      "A deleted data store still uses this name, and its database still exists. The name is free once an admin for all workspaces removes that database.",
    "refusals.dataStoreScopeUnknown":
      "The data store names an unknown data area. Ask the agent to change it.",
    "refusals.dataStoreScopeMismatch":
      "The data store is written for a different place than where it is. Ask the agent to change it.",
    "refusals.dataStoreChangeApplied":
      "The data store already applied a change to its structure that this version leaves out or alters. An applied change stays as it is: ask the agent to add a new one instead.",
    "refusals.dataStoreRecordKey":
      "The table “{table}” needs the column “{field}” with a unique key. Ask the agent to add it.",
    "refusals.dataStoreScopeColumn":
      "The table “{table}” is not built the way a data store separated by area needs it. Ask the agent to change it.",
    "refusals.dataStoreScopeUnchecked":
      "This change to the data store cannot be published, because its tables separated by area could not be checked. Ask the agent to check the change against the store as it is now.",
    "refusals.workflowUnavailable":
      "The Workflow “{workflow}” that this app starts is not published. Publish the Workflow first, then the app.",
    "refusals.workflowInputMissing":
      "The action “{action}” does not pass “{input}”, which the Workflow “{workflow}” needs.",
    "refusals.workflowInputUndeclared":
      "The action “{action}” passes “{input}”, which the Workflow “{workflow}” does not take.",
    "refusals.workflowNotReached":
      "The app no longer starts the Workflow “{workflow}”, so it is not published with it. Open the dialog again to see what goes live.",
    "refusals.workflowNamedTwice":
      "The Workflow “{workflow}” is named twice. Open the dialog again.",
    "refusals.workflowsWithoutApp": "Only publishing an app makes Workflows live with it.",
    "refusals.workflowDefinition":
      "The Workflow cannot run in this version. Ask the agent to check its steps.",
    "refusals.workflowNoManualStart": "This Workflow cannot be started by hand.",
    "refusals.workflowRightNotHeld":
      "The Workflow's account cannot hold the right “{right}”. Ask the agent to take it out.",
    "refusals.workflowRightOnNothing":
      "The Workflow needs the right “{right}” on something that does not exist. Ask the agent to check it.",
    "refusals.workflowNotVisible":
      "The Workflow needs something you may not see, so you cannot give it a right on it.",
    "refusals.workflowPackage":
      "The Workflow uses a software package that is not available here. Ask the agent to do without it.",
    "refusals.personContextUnmapped":
      "Your account is not linked to a connection this Workflow uses.",
    "refusals.revisionFilesRemoved":
      "The files of this version are not stored any more, so it cannot be published or shown.",
    "refusals.revisionUnknown":
      "This version is not there any more. Reload the page and try again.",
    "refusals.revisionChanged":
      "This changed after you opened it. Reload the page and check it again.",
    "refusals.liveMoved":
      "Who the app is live for changed in the meantime. Check it again, then publish.",
    "refusals.referenceOutOfScope":
      "This uses something from another workspace. It can only use what belongs to its own workspace or is for everyone. Make that item there, or ask an admin to.",
    "refusals.referenceOnlyMine":
      "This uses something that is “Only me”. What a team or everyone uses may not rely on it. Create it in the team or for everyone, or ask an admin.",
    "refusals.offerOnlyMine":
      "This is “Only me”, so it cannot be offered to a team or to everyone. Create it in the team or for everyone, or ask an admin.",
    "refusals.referenceForAll":
      "This is for everyone, but it uses {target}. Something for everyone can only use what is for everyone too. Make that item under “Everyone”, or ask an admin to.",
    "refusals.referenceForWorkspace":
      "This belongs to {source} and uses {target}. It can only use what belongs to {source} or is for everyone. Make that item in {source}, or ask an admin to.",
    "refusals.referenceForMine":
      "This is yours alone and uses {target}. It can only use what is yours or for everyone. Make that item under “Only me”.",
    "refusals.referenceTargetMine": "something only you have",
    "refusals.referenceTargetWorkspace": "something of {workspace}",
    "refusals.referenceTargetOther": "something of another workspace",
    "refusals.publishSubjectUnreadable":
      "This request does not say what it publishes, so nobody can decide it.",
    "refusals.inputTooLargeToHold":
      "This change needs an approval, and it is too large to be held for one.",
    "refusals.appInstanceNeedsSharedWorkspace":
      "This app is “Only me”, so it cannot be for everyone. Build it in a team, or ask an admin.",
    "refusals.moduleOff": "A part of the platform this needs is switched off.",
    "refusals.rightMissing": "You need the right “{right}” for this.",
    "refusals.rightDenied": "The right “{right}” is denied to you here.",
    "refusals.usageLimitReached":
      "A usage limit was reached, so this could not run. It works again once the limit resets or an admin for all workspaces raises it.",
    "refusals.usageLimitNamed":
      "The {period} limit on {metric} was reached. It counts {scope} and resets {reset}. An admin for all workspaces can raise it.",
    "refusals.openDataStore": "Open data store",
    "refusals.openWorkflow": "Open Workflow",
    "refusals.openApp": "Open app"
  },
  de: {
    "refusals.dataStoreBelowMinSchema":
      "Die App braucht den Datenspeicher „{dataStore}“ in einer neueren Fassung. Veröffentliche ihn zusammen mit der App.",
    "refusals.dataStoreNeedsApp":
      "Diese Vorschau erreicht keine Datenspeicher. Zum Testen mit echten Daten öffne die App.",
    "refusals.dataStoreUnavailable": "Den Datenspeicher „{dataStore}“ gibt es hier nicht (mehr).",
    "refusals.dataStoreNotListed":
      "Die Aktion „{action}“ nutzt den Datenspeicher „{dataStore}“, den die App nicht angibt. Bitte den Agenten, ihn in der App einzutragen.",
    "refusals.dataStoreNamedTwice":
      "Der Datenspeicher „{dataStore}“ ist doppelt genannt. Öffne den Dialog noch einmal.",
    "refusals.dataStoreNotReached":
      "Die App nutzt den Datenspeicher „{dataStore}“ nicht, darum wird er nicht mit ihr veröffentlicht. Öffne den Dialog noch einmal, um zu sehen, was live geht.",
    "refusals.dataStoreDraftBelowMinSchema":
      "Die App braucht eine neuere Fassung des Datenspeichers „{dataStore}“, als sein Entwurf hat. Bitte den Agenten, den Datenspeicher zu ergänzen.",
    "refusals.dataStoreJobExhausted":
      "Die Einrichtung oder Umstellung des Datenspeichers „{dataStore}“ wurde abgebrochen und wird nicht mehr automatisch versucht. Bitte einen Administrator, den Auftrag unter System > Jobs erneut zu starten. Veröffentliche danach die App erneut.",
    "refusals.dataStoreMigrationFailed":
      "Die Änderung „{migration}“ am Datenspeicher „{dataStore}“ ließ sich nicht anwenden. Die App ist nicht veröffentlicht.",
    "refusals.dataStoreMigrationFailedUnnamed":
      "Eine Änderung am Datenspeicher „{dataStore}“ ließ sich nicht anwenden. Die App ist nicht veröffentlicht.",
    "refusals.dataStoreMigrating":
      "Der Datenspeicher „{dataStore}“ wird noch umgestellt. Versuche es in einer Minute noch einmal.",
    "refusals.dataHandoverNeedsOwner":
      "{readers} Personen, die den Datenspeicher „{dataStore}“ danach lesen, dürfen „{connection}“ nicht nutzen. Bitte eine Person, die „{connection}“ verwalten darf, diese Version zu veröffentlichen und die Weitergabe zu bestätigen, oder schränke ein, wer den Datenspeicher liest.",
    "refusals.dataHandoverNeedsOwnerHidden":
      "{readers} Personen, die den Datenspeicher „{dataStore}“ danach lesen, dürfen eine seiner Quellen nicht nutzen. Bitte eine Person, die diese Quelle verwalten darf, diese Version zu veröffentlichen und die Weitergabe zu bestätigen, oder schränke ein, wer den Datenspeicher liest.",
    "refusals.dataHandoverUnconfirmed":
      "Wer den Datenspeicher „{dataStore}“ liest, hat sich seit der Frage geändert. Öffne den Dialog erneut, lies, wer die Daten erhält, und veröffentliche noch einmal.",
    "refusals.dataStoreNotReady":
      "Der Datenspeicher ist noch nicht bereit. Versuche es gleich noch einmal.",
    "refusals.dataStoreKeyReused":
      "Die App hat diese Änderung zweimal mit verschiedenem Inhalt geschickt. Lade die App neu und versuche es noch einmal.",
    "refusals.rowsTooLarge":
      "Diese Änderung ist für einen Aufruf zu groß. Teile sie auf mehrere Aufrufe auf.",
    "refusals.rowsTooMany":
      "Diese Änderung enthält zu viele Einträge für einen Aufruf. Teile sie auf mehrere Aufrufe auf.",
    "refusals.dataStoreIdHeld":
      "Ein gelöschter Datenspeicher belegt diesen Namen noch, und seine Datenbank gibt es noch. Der Name wird frei, sobald ein Admin für alle Arbeitsbereiche diese Datenbank entfernt.",
    "refusals.dataStoreScopeUnknown":
      "Der Datenspeicher nennt einen unbekannten Datenbereich. Bitte den Agenten, ihn anzupassen.",
    "refusals.dataStoreScopeMismatch":
      "Der Datenspeicher ist für einen anderen Ort geschrieben, als er liegt. Bitte den Agenten, ihn anzupassen.",
    "refusals.dataStoreChangeApplied":
      "Der Datenspeicher hat eine Änderung seines Aufbaus schon angewendet, die diese Fassung weglässt oder ändert. Eine angewendete Änderung bleibt, wie sie ist: Bitte den Agenten, stattdessen eine neue hinzuzufügen.",
    "refusals.dataStoreRecordKey":
      "Die Tabelle „{table}“ braucht die Spalte „{field}“ mit einem eindeutigen Schlüssel. Bitte den Agenten, ihn anzulegen.",
    "refusals.dataStoreScopeColumn":
      "Die Tabelle „{table}“ ist nicht so aufgebaut, wie ein nach Bereichen getrennter Datenspeicher es braucht. Bitte den Agenten, sie anzupassen.",
    "refusals.dataStoreScopeUnchecked":
      "Diese Änderung am Datenspeicher lässt sich nicht veröffentlichen, weil seine nach Bereichen getrennten Tabellen nicht geprüft werden konnten. Bitte den Agenten, die Änderung am aktuellen Stand des Speichers zu prüfen.",
    "refusals.workflowUnavailable":
      "Der Workflow „{workflow}“, den diese App startet, ist nicht veröffentlicht. Veröffentliche zuerst den Workflow, dann die App.",
    "refusals.workflowInputMissing":
      "Die Aktion „{action}“ übergibt „{input}“ nicht, das der Workflow „{workflow}“ braucht.",
    "refusals.workflowInputUndeclared":
      "Die Aktion „{action}“ übergibt „{input}“, das der Workflow „{workflow}“ nicht annimmt.",
    "refusals.workflowNotReached":
      "Die App startet den Workflow „{workflow}“ nicht mehr, darum wird er nicht mit ihr veröffentlicht. Öffne den Dialog noch einmal, um zu sehen, was live geht.",
    "refusals.workflowNamedTwice":
      "Der Workflow „{workflow}“ ist doppelt genannt. Öffne den Dialog noch einmal.",
    "refusals.workflowsWithoutApp":
      "Nur das Veröffentlichen einer App macht Workflows mit ihr live.",
    "refusals.workflowDefinition":
      "Der Workflow kann in dieser Fassung nicht laufen. Bitte den Agenten, seine Schritte zu prüfen.",
    "refusals.workflowNoManualStart": "Dieser Workflow lässt sich nicht von Hand starten.",
    "refusals.workflowRightNotHeld":
      "Das Konto des Workflows kann das Recht „{right}“ nicht halten. Bitte den Agenten, es herauszunehmen.",
    "refusals.workflowRightOnNothing":
      "Der Workflow braucht das Recht „{right}“ auf etwas, das es nicht gibt. Bitte den Agenten, das zu prüfen.",
    "refusals.workflowNotVisible":
      "Der Workflow braucht etwas, das du nicht sehen darfst. Darum kannst du ihm darauf kein Recht geben.",
    "refusals.workflowPackage":
      "Der Workflow nutzt ein Softwarepaket, das es hier nicht gibt. Bitte den Agenten, ohne es auszukommen.",
    "refusals.personContextUnmapped":
      "Dein Konto ist mit einer Verbindung, die dieser Workflow nutzt, nicht verknüpft.",
    "refusals.revisionFilesRemoved":
      "Die Dateien dieser Version sind nicht mehr gespeichert. Sie lässt sich weder veröffentlichen noch anzeigen.",
    "refusals.revisionUnknown":
      "Diese Version gibt es nicht mehr. Lade die Seite neu und versuche es noch einmal.",
    "refusals.revisionChanged":
      "Das hat sich geändert, seit du es geöffnet hast. Lade die Seite neu und prüfe es noch einmal.",
    "refusals.liveMoved":
      "Für wen die App live ist, hat sich inzwischen geändert. Prüfe es noch einmal und veröffentliche dann.",
    "refusals.referenceOutOfScope":
      "Das verwendet etwas aus einem anderen Arbeitsbereich. Es kann nur verwenden, was zum eigenen Arbeitsbereich gehört oder für alle ist. Lege es dort an oder bitte einen Admin darum.",
    "refusals.referenceOnlyMine":
      "Das nutzt etwas, das „Nur ich“ ist. Was ein Team oder Alle nutzen, darf sich nicht darauf stützen. Lege es im Team oder für Alle an, oder bitte einen Admin darum.",
    "refusals.offerOnlyMine":
      "Das ist „Nur ich“ und kann darum keinem Team und nicht Allen angeboten werden. Lege es im Team oder für Alle an, oder bitte einen Admin darum.",
    "refusals.referenceForAll":
      "Das ist für alle, verwendet aber {target}. Was für alle ist, kann nur verwenden, was auch für alle ist. Lege es unter „Alle“ an oder bitte einen Admin darum.",
    "refusals.referenceForWorkspace":
      "Das gehört zu {source} und verwendet {target}. Es kann nur verwenden, was zu {source} gehört oder für alle ist. Lege es in {source} an oder bitte einen Admin darum.",
    "refusals.referenceForMine":
      "Das gehört nur dir und verwendet {target}. Es kann nur verwenden, was dir gehört oder für alle ist. Lege es unter „Nur ich“ an.",
    "refusals.referenceTargetMine": "etwas, das nur dir gehört",
    "refusals.referenceTargetWorkspace": "etwas aus {workspace}",
    "refusals.referenceTargetOther": "etwas aus einem anderen Arbeitsbereich",
    "refusals.publishSubjectUnreadable":
      "Diese Anfrage sagt nicht, was sie veröffentlicht. Darum kann niemand sie entscheiden.",
    "refusals.inputTooLargeToHold":
      "Diese Änderung braucht eine Freigabe und ist zu groß, um dafür zurückgehalten zu werden.",
    "refusals.appInstanceNeedsSharedWorkspace":
      "Diese App ist „Nur ich“ und kann darum nicht für Alle sein. Baue sie in einem Team, oder bitte einen Admin darum.",
    "refusals.moduleOff": "Ein Teil der Plattform, den das braucht, ist ausgeschaltet.",
    "refusals.rightMissing": "Dafür brauchst du das Recht „{right}“.",
    "refusals.rightDenied": "Das Recht „{right}“ ist dir hier verwehrt.",
    "refusals.usageLimitReached":
      "Eine Nutzungsgrenze wurde erreicht, deshalb konnte das nicht laufen. Es geht wieder, sobald die Grenze zurückgesetzt oder von einem Admin für alle Arbeitsbereiche erhöht wird.",
    "refusals.usageLimitNamed":
      "Die {period} Grenze für {metric} wurde erreicht. Sie zählt {scope} und wird {reset} zurückgesetzt. Ein Admin für alle Arbeitsbereiche kann sie erhöhen.",
    "refusals.openDataStore": "Datenspeicher öffnen",
    "refusals.openWorkflow": "Workflow öffnen",
    "refusals.openApp": "App öffnen"
  }
});
