import { defineTranslations } from "./translation-area";

/** What an agent opened beside the conversation: its card in the thread, the preview and the source files. */
export const pages = defineTranslations({
  en: {
    "pages.connectionUseDenied":
      "You may not use the connection {name}, so this cannot load. Trying again will not help.",
    "pages.connectionUseDeniedUnnamed":
      "You may not use a connection this app needs, so this cannot load. Trying again will not help.",
    "pages.connectionUseDeniedUnnamedPage":
      "You may not use a connection this preview needs, so this cannot load. Trying again will not help.",
    "pages.buildErrors": "{count} build errors",
    "pages.callWaits": "This action is waiting for an approval.",
    "pages.callWaitsOpen": "Open in Inbox",
    "pages.buildErrorsOne": "1 build error",
    "pages.cardBuilding": "Building the preview",
    "pages.cardErrors": "The preview could not be built",
    "pages.cardFailed": "The preview could not be opened",
    "pages.errorPlace": "{file}, line {line}",
    "pages.errorsKeepShown":
      "The preview still shows the last version. Ask the agent to fix the errors.",
    "pages.errorsKeepShownOne":
      "The preview still shows the last version. Ask the agent to fix the error.",
    "pages.errorsNothingSaved": "Nothing new is shown. Ask the agent to fix the errors.",
    "pages.errorsNothingSavedOne": "Nothing new is shown. Ask the agent to fix the error.",
    "pages.files": "Files",
    "pages.filesEmpty": "This preview has no source files.",
    "pages.filesFailed": "The files could not be loaded.",
    "pages.filesList": "Source files",
    "pages.fileChanged": "Changed",
    "pages.fileNotText": "This file is not text and cannot be shown.",
    "pages.fileTooLargeToColour": "Too large for syntax colours",
    "pages.gone": "This preview is no longer available to you.",
    "pages.loadFailed": "The preview could not be loaded.",
    "pages.loading": "The preview is loading",
    "pages.notSavedToApp": "The draft of {title} was not changed. The agent says why.",
    "pages.open": "Open",
    "pages.preview": "Preview",
    "pages.previewOf": "Preview of {name}",
    "pages.retry": "Try again",
    "pages.savedToApp": "Saved to the draft of {title}",
    "pages.showFileList": "All files",
    "pages.shown": "Shown",
    "pages.testRunDraft": "Test run of the draft · Workflow draft",
    "pages.testRunPublished": "Test run · published Workflow",
    "pages.testRunSimulated": "{count} steps simulated",
    "pages.testRunSimulatedOne": "1 step simulated",
    "pages.testRunView": "View run",
    "pages.unnamed": "Preview",
    "pages.view": "Content of the preview"
  },
  de: {
    "pages.connectionUseDenied":
      "Du darfst die Verbindung {name} nicht nutzen, deshalb lässt sich das nicht laden. Ein erneuter Versuch hilft nicht.",
    "pages.connectionUseDeniedUnnamed":
      "Du darfst eine Verbindung nicht nutzen, die diese App braucht, deshalb lässt sich das nicht laden. Ein erneuter Versuch hilft nicht.",
    "pages.connectionUseDeniedUnnamedPage":
      "Du darfst eine Verbindung nicht nutzen, die diese Vorschau braucht, deshalb lässt sich das nicht laden. Ein erneuter Versuch hilft nicht.",
    "pages.buildErrors": "{count} Build-Fehler",
    "pages.callWaits": "Diese Aktion wartet auf eine Freigabe.",
    "pages.callWaitsOpen": "Im Eingang öffnen",
    "pages.buildErrorsOne": "1 Build-Fehler",
    "pages.cardBuilding": "Die Vorschau wird gebaut",
    "pages.cardErrors": "Die Vorschau konnte nicht gebaut werden",
    "pages.cardFailed": "Die Vorschau konnte nicht geöffnet werden",
    "pages.errorPlace": "{file}, Zeile {line}",
    "pages.errorsKeepShown":
      "Die Vorschau zeigt weiter den letzten Stand. Bitte den Agenten, die Fehler zu beheben.",
    "pages.errorsKeepShownOne":
      "Die Vorschau zeigt weiter den letzten Stand. Bitte den Agenten, den Fehler zu beheben.",
    "pages.errorsNothingSaved":
      "Es wird nichts Neues gezeigt. Bitte den Agenten, die Fehler zu beheben.",
    "pages.errorsNothingSavedOne":
      "Es wird nichts Neues gezeigt. Bitte den Agenten, den Fehler zu beheben.",
    "pages.files": "Dateien",
    "pages.filesEmpty": "Diese Vorschau hat keine Quelldateien.",
    "pages.filesFailed": "Die Dateien konnten nicht geladen werden.",
    "pages.filesList": "Quelldateien",
    "pages.fileChanged": "Geändert",
    "pages.fileNotText": "Diese Datei ist kein Text und kann nicht angezeigt werden.",
    "pages.fileTooLargeToColour": "Zu groß für Syntaxfarben",
    "pages.gone": "Diese Vorschau ist für dich nicht mehr verfügbar.",
    "pages.loadFailed": "Die Vorschau konnte nicht geladen werden.",
    "pages.loading": "Die Vorschau wird geladen",
    "pages.notSavedToApp": "Der Entwurf von {title} wurde nicht geändert. Der Agent sagt, warum.",
    "pages.open": "Öffnen",
    "pages.preview": "Vorschau",
    "pages.previewOf": "Vorschau von {name}",
    "pages.retry": "Erneut versuchen",
    "pages.savedToApp": "Im Entwurf von {title} gespeichert",
    "pages.showFileList": "Alle Dateien",
    "pages.shown": "Angezeigt",
    "pages.testRunDraft": "Testlauf des Entwurfs · Workflow-Entwurf",
    "pages.testRunPublished": "Testlauf · veröffentlichter Workflow",
    "pages.testRunSimulated": "{count} Schritte simuliert",
    "pages.testRunSimulatedOne": "1 Schritt simuliert",
    "pages.testRunView": "Lauf ansehen",
    "pages.unnamed": "Vorschau",
    "pages.view": "Inhalt der Vorschau"
  }
});
