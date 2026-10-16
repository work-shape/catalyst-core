import { defineTranslations } from "./translation-area";

export const skillFiles = defineTranslations({
  en: {
    "skillFiles.addTo": "Add a file to {folder}",
    "skillFiles.binary":
      "This file is not text, so it is not edited here. Replace it with a new version or download it.",
    "skillFiles.content": "Content",
    "skillFiles.delete": "Delete",
    "skillFiles.description":
      "SKILL.md holds the instructions. The agent reads references when it needs them, and uses scripts and assets in its workspace.",
    "skillFiles.download": "Download",
    "skillFiles.hash": "SHA-256 {hash}",
    "skillFiles.loadFailed": "The files of the skill could not be loaded.",
    "skillFiles.loading": "Loading the files of the skill…",
    "skillFiles.name": "Name",
    "skillFiles.new": "New file",
    "skillFiles.notSaved": "Not saved yet",
    "skillFiles.refusedExecutable":
      "{path} is a compiled program. A skill holds scripts as text, not programs.",
    "skillFiles.refusedLfs":
      "{path} is a Git LFS pointer, not the file itself. Upload the file itself.",
    "skillFiles.refusedNotText":
      "{path} is not UTF-8 text. Scripts and text files have to be UTF-8 text.",
    "skillFiles.refusedPath": "{path} cannot be the name of a file of a skill.",
    "skillFiles.refusedPathBelowFile":
      "{path} lies below {folder}, which is a file itself. A name is a file or a folder, not both.",
    "skillFiles.refusedPathTwice":
      "{path} is in the skill twice. Names that differ only in upper and lower case count as one.",
    "skillFiles.refusedTooLarge": "{path} has {size}. A file of a skill has at most {limit}.",
    "skillFiles.refusedTooMany": "The skill has {count} files. A skill has at most {limit}.",
    "skillFiles.refusedTotal":
      "The files of the skill have {size} together. A skill has at most {limit}.",
    "skillFiles.refusedUnavailable":
      "This instance keeps no files beside the text of a skill, so {path} cannot be saved.",
    "skillFiles.replace": "Replace",
    "skillFiles.title": "Files",
    "skillFiles.upload": "Upload file"
  },
  de: {
    "skillFiles.addTo": "Datei zu {folder} hinzufügen",
    "skillFiles.binary":
      "Diese Datei ist kein Text und wird darum hier nicht bearbeitet. Ersetze sie durch eine neue Fassung oder lade sie herunter.",
    "skillFiles.content": "Inhalt",
    "skillFiles.delete": "Löschen",
    "skillFiles.description":
      "SKILL.md enthält die Anweisungen. Referenzen liest der Agent, wenn er sie braucht, Skripte und Assets nutzt er in seinem Arbeitsbereich.",
    "skillFiles.download": "Herunterladen",
    "skillFiles.hash": "SHA-256 {hash}",
    "skillFiles.loadFailed": "Die Dateien des Skills konnten nicht geladen werden.",
    "skillFiles.loading": "Die Dateien des Skills werden geladen…",
    "skillFiles.name": "Name",
    "skillFiles.new": "Neue Datei",
    "skillFiles.notSaved": "Noch nicht gespeichert",
    "skillFiles.refusedExecutable":
      "{path} ist ein kompiliertes Programm. Ein Skill enthält Skripte als Text, keine Programme.",
    "skillFiles.refusedLfs":
      "{path} ist ein Git-LFS-Verweis und nicht die Datei selbst. Lade die Datei selbst hoch.",
    "skillFiles.refusedNotText":
      "{path} ist kein UTF-8-Text. Skripte und Textdateien müssen UTF-8-Text sein.",
    "skillFiles.refusedPath": "{path} kann nicht der Name einer Datei eines Skills sein.",
    "skillFiles.refusedPathBelowFile":
      "{path} liegt unter {folder}, und {folder} ist selbst eine Datei. Ein Name ist eine Datei oder ein Ordner, nicht beides.",
    "skillFiles.refusedPathTwice":
      "{path} ist zweimal im Skill. Namen, die sich nur in Groß- und Kleinschreibung unterscheiden, zählen als einer.",
    "skillFiles.refusedTooLarge":
      "{path} hat {size}. Eine Datei eines Skills hat höchstens {limit}.",
    "skillFiles.refusedTooMany": "Der Skill hat {count} Dateien. Ein Skill hat höchstens {limit}.",
    "skillFiles.refusedTotal":
      "Die Dateien des Skills haben zusammen {size}. Ein Skill hat höchstens {limit}.",
    "skillFiles.refusedUnavailable":
      "Diese Instanz speichert neben dem Text eines Skills keine Dateien, darum kann {path} nicht gespeichert werden.",
    "skillFiles.replace": "Ersetzen",
    "skillFiles.title": "Dateien",
    "skillFiles.upload": "Datei hochladen"
  }
});
