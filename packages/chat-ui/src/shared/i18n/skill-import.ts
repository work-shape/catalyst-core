import { defineTranslations } from "./translation-area";

export const skillImport = defineTranslations({
  en: {
    "skillImport.action": "Import skill",
    "skillImport.added": "Added",
    "skillImport.archiveTooLarge":
      "The archive has {size}. An archive of a skill has at most {limit}.",
    "skillImport.archiveUnreadable": "This file cannot be read as a .zip archive.",
    "skillImport.changed": "Changed",
    "skillImport.chooseAnother": "Choose another",
    "skillImport.chooseFolder": "Choose folder",
    "skillImport.chooseZip": "Choose .zip",
    "skillImport.create": "Import",
    "skillImport.drop": "Drop a skill's folder or its .zip here.",
    "skillImport.files": "{count} files · {size}",
    "skillImport.link": "{path} is a link. A skill holds files, not links.",
    "skillImport.manifestInvalid": "SKILL.md cannot be read as a skill: {reason}",
    "skillImport.nameHint": "Letters, digits, '.', '_' and '-', starting with a letter or a digit.",
    "skillImport.nameInvalid":
      "An address starts with a letter or a digit and holds only letters, digits, '.', '_' and '-'.",
    "skillImport.nameTaken": "A skill with the address {name} exists already.",
    "skillImport.nameTakenOther":
      "A skill with the address {name} exists already. Choose another address.",
    "skillImport.noChanges": "The folder holds the same files as the skill.",
    "skillImport.noSkill": "This folder is no skill: it has no SKILL.md at its top.",
    "skillImport.reading": "Reading the files…",
    "skillImport.removed": "Removed",
    "skillImport.replace": "Replace the files of {title}",
    "skillImport.replaceAction": "Replace from folder",
    "skillImport.replaceDescription":
      "Every file of the skill becomes the folder's. The skill keeps its address, and a save writes a new revision.",
    "skillImport.sizeChange": "{before} → {after}",
    "skillImport.unchanged": "{count} files stay as they are.",
    "skillImport.unsaved": "Changes on this page that are not saved are replaced as well."
  },
  de: {
    "skillImport.action": "Skill importieren",
    "skillImport.added": "Neu",
    "skillImport.archiveTooLarge":
      "Das Archiv hat {size}. Ein Archiv eines Skills hat höchstens {limit}.",
    "skillImport.archiveUnreadable": "Diese Datei lässt sich nicht als .zip-Archiv lesen.",
    "skillImport.changed": "Geändert",
    "skillImport.chooseAnother": "Andere auswählen",
    "skillImport.chooseFolder": "Ordner auswählen",
    "skillImport.chooseZip": ".zip auswählen",
    "skillImport.create": "Importieren",
    "skillImport.drop": "Lege den Ordner eines Skills oder sein .zip hier ab.",
    "skillImport.files": "{count} Dateien · {size}",
    "skillImport.link": "{path} ist ein Verweis. Ein Skill enthält Dateien, keine Verweise.",
    "skillImport.manifestInvalid": "SKILL.md lässt sich nicht als Skill lesen: {reason}",
    "skillImport.nameHint":
      "Buchstaben, Ziffern, „.“, „_“ und „-“, am Anfang ein Buchstabe oder eine Ziffer.",
    "skillImport.nameInvalid":
      "Eine Adresse beginnt mit einem Buchstaben oder einer Ziffer und enthält nur Buchstaben, Ziffern, „.“, „_“ und „-“.",
    "skillImport.nameTaken": "Es gibt schon einen Skill mit der Adresse {name}.",
    "skillImport.nameTakenOther":
      "Es gibt schon einen Skill mit der Adresse {name}. Wähle eine andere Adresse.",
    "skillImport.noChanges": "Der Ordner enthält dieselben Dateien wie der Skill.",
    "skillImport.noSkill": "Dieser Ordner ist kein Skill: Er hat oben kein SKILL.md.",
    "skillImport.reading": "Die Dateien werden gelesen…",
    "skillImport.removed": "Entfernt",
    "skillImport.replace": "Dateien von {title} ersetzen",
    "skillImport.replaceAction": "Aus Ordner ersetzen",
    "skillImport.replaceDescription":
      "Jede Datei des Skills wird die des Ordners. Der Skill behält seine Adresse, und Speichern schreibt eine neue Revision.",
    "skillImport.sizeChange": "{before} → {after}",
    "skillImport.unchanged": "{count} Dateien bleiben, wie sie sind.",
    "skillImport.unsaved":
      "Nicht gespeicherte Änderungen auf dieser Seite werden ebenfalls ersetzt."
  }
});
