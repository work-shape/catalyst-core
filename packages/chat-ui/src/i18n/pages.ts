import { defineTranslations } from "./translation-area";

/** A Page beside the conversation: its card in the thread, the preview and the source files. */
export const pages = defineTranslations({
  en: {
    "pages.connectionUseDenied":
      "You may not use the connection {name}, so this cannot load. Trying again will not help. An administrator can give you the right under Settings > Instance > Access.",
    "pages.connectionUseDeniedUnnamed":
      "You may not use a connection this app needs, so this cannot load. Trying again will not help. An administrator can give you the right under Settings > Instance > Access.",
    "pages.connectionUseDeniedUnnamedPage":
      "You may not use a connection this page needs, so this cannot load. Trying again will not help. An administrator can give you the right under Settings > Instance > Access.",
    "pages.buildErrors": "{count} build errors",
    "pages.buildErrorsOne": "1 build error",
    "pages.cardBuilding": "Building the Page",
    "pages.cardErrors": "The Page could not be built",
    "pages.cardFailed": "The Page could not be saved",
    "pages.errorPlace": "{file}, line {line}",
    "pages.errorsKeepRevision":
      "The preview still shows revision {number}. Ask the agent to fix the errors.",
    "pages.errorsKeepRevisionOne":
      "The preview still shows revision {number}. Ask the agent to fix the error.",
    "pages.errorsNothingSaved": "Nothing was saved. Ask the agent to fix the errors.",
    "pages.errorsNothingSavedOne": "Nothing was saved. Ask the agent to fix the error.",
    "pages.files": "Files",
    "pages.filesEmpty": "This revision has no source files.",
    "pages.filesFailed": "The files could not be loaded.",
    "pages.filesList": "Source files",
    "pages.fileChanged": "Changed",
    "pages.fileNotText": "This file is not text and cannot be shown.",
    "pages.fileTooLargeToColour": "Too large for syntax colours",
    "pages.gone": "This Page is no longer available to you.",
    "pages.loadFailed": "The Page could not be loaded.",
    "pages.loading": "The Page is loading",
    "pages.open": "Open",
    "pages.preview": "Preview",
    "pages.previewOf": "Preview of {name}",
    "pages.retry": "Try again",
    "pages.revision": "Revision {number}",
    "pages.showFileList": "All files",
    "pages.shown": "Shown",
    "pages.unnamed": "Page",
    "pages.view": "View of the Page"
  },
  de: {
    "pages.connectionUseDenied":
      "Du darfst die Verbindung {name} nicht nutzen, deshalb lässt sich das nicht laden. Ein erneuter Versuch hilft nicht. Ein Administrator kann dir das Recht unter Einstellungen > Instanz > Zugriff geben.",
    "pages.connectionUseDeniedUnnamed":
      "Du darfst eine Verbindung nicht nutzen, die diese App braucht, deshalb lässt sich das nicht laden. Ein erneuter Versuch hilft nicht. Ein Administrator kann dir das Recht unter Einstellungen > Instanz > Zugriff geben.",
    "pages.connectionUseDeniedUnnamedPage":
      "Du darfst eine Verbindung nicht nutzen, die diese Seite braucht, deshalb lässt sich das nicht laden. Ein erneuter Versuch hilft nicht. Ein Administrator kann dir das Recht unter Einstellungen > Instanz > Zugriff geben.",
    "pages.buildErrors": "{count} Build-Fehler",
    "pages.buildErrorsOne": "1 Build-Fehler",
    "pages.cardBuilding": "Die Page wird gebaut",
    "pages.cardErrors": "Die Page konnte nicht gebaut werden",
    "pages.cardFailed": "Die Page konnte nicht gespeichert werden",
    "pages.errorPlace": "{file}, Zeile {line}",
    "pages.errorsKeepRevision":
      "Die Vorschau zeigt weiter Revision {number}. Bitte den Agenten, die Fehler zu beheben.",
    "pages.errorsKeepRevisionOne":
      "Die Vorschau zeigt weiter Revision {number}. Bitte den Agenten, den Fehler zu beheben.",
    "pages.errorsNothingSaved":
      "Es wurde nichts gespeichert. Bitte den Agenten, die Fehler zu beheben.",
    "pages.errorsNothingSavedOne":
      "Es wurde nichts gespeichert. Bitte den Agenten, den Fehler zu beheben.",
    "pages.files": "Dateien",
    "pages.filesEmpty": "Diese Revision hat keine Quelldateien.",
    "pages.filesFailed": "Die Dateien konnten nicht geladen werden.",
    "pages.filesList": "Quelldateien",
    "pages.fileChanged": "Geändert",
    "pages.fileNotText": "Diese Datei ist kein Text und kann nicht angezeigt werden.",
    "pages.fileTooLargeToColour": "Zu groß für Syntaxfarben",
    "pages.gone": "Diese Page ist für dich nicht mehr verfügbar.",
    "pages.loadFailed": "Die Page konnte nicht geladen werden.",
    "pages.loading": "Die Page wird geladen",
    "pages.open": "Öffnen",
    "pages.preview": "Vorschau",
    "pages.previewOf": "Vorschau von {name}",
    "pages.retry": "Erneut versuchen",
    "pages.revision": "Revision {number}",
    "pages.showFileList": "Alle Dateien",
    "pages.shown": "Angezeigt",
    "pages.unnamed": "Page",
    "pages.view": "Ansicht der Page"
  }
});
