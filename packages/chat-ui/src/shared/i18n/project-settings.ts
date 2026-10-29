import { defineTranslations } from "./translation-area";

/** A whole project (PRJ-6): who sees it, the workspace it is in, and its deletion. */
export const projectSettings = defineTranslations({
  en: {
    "projectSettings.share": "Share with workspace",
    "projectSettings.makePrivate": "Make private",
    "projectSettings.moveToWorkspace": "Move to workspace…",
    "projectSettings.delete": "Delete…",
    "projectSettings.chats": "{count} chats",
    "projectSettings.chatsOne": "1 chat",
    "projectSettings.files": "{count} files",
    "projectSettings.filesOne": "1 file",
    "projectSettings.loadFailed": "What the project holds could not be read.",
    "projectSettings.shareTitle": "Share {title} with {workspace}?",
    "projectSettings.shareBody":
      "Everyone in {workspace} sees the project, its files and its chats ({chats}). They can write in it and add chats.",
    "projectSettings.shareKept":
      "{chats} in this project hold personal data or read a data store, and stay private. Take them out of the project first.",
    "projectSettings.shareKeptFiles":
      "{files} in this project were written by a chat that stays private, or by one that is gone. Delete those files for good, or their versions from that chat, first.",
    "projectSettings.filesStayPrivate":
      "Files in this project were written by a chat that stays private. Delete those files for good, or their versions from that chat, first.",
    "projectSettings.shareConfirm": "Share",
    "projectSettings.privateTitle": "Make {title} private?",
    "projectSettings.privateBody":
      "Only you see the project, its files and your chats in it. The others in {workspace} no longer do.",
    "projectSettings.privateOthers":
      "{chats} by others leave the project and stay shared in {workspace}.",
    "projectSettings.privateFiles": "{files} added by others stay in the project.",
    "projectSettings.privateConfirm": "Make private",
    "projectSettings.moveTitle": "Move {title} to another workspace",
    "projectSettings.moveDescription":
      "The project moves with its files and chats. Shares of the project end.",
    "projectSettings.moveTo": "Workspace",
    "projectSettings.moveNone": "You are a member of no other workspace.",
    "projectSettings.movePersonal": "Only you will see it there, and its chats.",
    "projectSettings.moveKeeps": "It stays as it is: {audience}.",
    "projectSettings.moveAudience": "Who sees it there",
    "projectSettings.moveConfirm": "Move",
    "projectSettings.deleteTitle": "Delete {title}?",
    "projectSettings.deleteBody":
      "The project is deleted with its files ({files}) and all their versions. This cannot be undone.",
    "projectSettings.deleteChats": "Its chats ({chats})",
    "projectSettings.deleteKeep": "Keep them in {workspace}",
    "projectSettings.deleteKeepHint": "They stay as they are, outside a project.",
    "projectSettings.deleteAlso": "Delete them too",
    "projectSettings.deleteAlsoHint": "Deleted chats cannot be restored.",
    "projectSettings.deleteConfirm": "Delete project",
    "projectSettings.failed": "That did not work. Try again.",
    "projectSettings.busy": "A chat in this project is still working. Try again when it is done.",
    "projectSettings.stayPrivate":
      "A chat in this project holds personal data or reads a data store and stays private.",
    "projectSettings.othersChats":
      "The project holds chats by others, which would leave them. Take those chats out of the project first.",
    "projectSettings.memberOnly": "Only a member of both workspaces moves a project.",
    "projectSettings.changed": "Who sees the project changed meanwhile. Close and look again.",
    "projectSettings.deleteChatsOff": "Deleting chats is turned off here. Keep them instead."
  },
  de: {
    "projectSettings.share": "Mit Arbeitsbereich teilen",
    "projectSettings.makePrivate": "Privat machen",
    "projectSettings.moveToWorkspace": "In Arbeitsbereich verschieben …",
    "projectSettings.delete": "Löschen …",
    "projectSettings.chats": "{count} Chats",
    "projectSettings.chatsOne": "1 Chat",
    "projectSettings.files": "{count} Dateien",
    "projectSettings.filesOne": "1 Datei",
    "projectSettings.loadFailed": "Was im Projekt liegt, konnte nicht gelesen werden.",
    "projectSettings.shareTitle": "{title} mit {workspace} teilen?",
    "projectSettings.shareBody":
      "Alle in {workspace} sehen das Projekt, seine Dateien und seine Chats ({chats}). Sie können darin schreiben und Chats hinzufügen.",
    "projectSettings.shareKept":
      "{chats} in diesem Projekt enthalten personenbezogene Daten oder lesen einen Datenspeicher und bleiben privat. Nimm sie zuerst aus dem Projekt.",
    "projectSettings.shareKeptFiles":
      "{files} in diesem Projekt hat ein Chat geschrieben, der privat bleibt oder nicht mehr da ist. Lösche diese Dateien endgültig oder ihre Versionen aus diesem Chat zuerst.",
    "projectSettings.filesStayPrivate":
      "Dateien in diesem Projekt hat ein Chat geschrieben, der privat bleibt. Lösche diese Dateien endgültig oder ihre Versionen aus diesem Chat zuerst.",
    "projectSettings.shareConfirm": "Teilen",
    "projectSettings.privateTitle": "{title} privat machen?",
    "projectSettings.privateBody":
      "Nur du siehst das Projekt, seine Dateien und deine Chats darin. Die anderen in {workspace} nicht mehr.",
    "projectSettings.privateOthers":
      "{chats} von anderen verlassen das Projekt und bleiben in {workspace} geteilt.",
    "projectSettings.privateFiles": "{files} von anderen bleiben im Projekt.",
    "projectSettings.privateConfirm": "Privat machen",
    "projectSettings.moveTitle": "{title} in einen anderen Arbeitsbereich verschieben",
    "projectSettings.moveDescription":
      "Das Projekt zieht mit seinen Dateien und Chats um. Freigaben des Projekts enden.",
    "projectSettings.moveTo": "Arbeitsbereich",
    "projectSettings.moveNone": "Du bist in keinem anderen Arbeitsbereich Mitglied.",
    "projectSettings.movePersonal": "Dort siehst nur du es und seine Chats.",
    "projectSettings.moveKeeps": "Es bleibt, wie es ist: {audience}.",
    "projectSettings.moveAudience": "Wer es dort sieht",
    "projectSettings.moveConfirm": "Verschieben",
    "projectSettings.deleteTitle": "{title} löschen?",
    "projectSettings.deleteBody":
      "Das Projekt wird mit seinen Dateien ({files}) und all ihren Versionen gelöscht. Das lässt sich nicht rückgängig machen.",
    "projectSettings.deleteChats": "Seine Chats ({chats})",
    "projectSettings.deleteKeep": "In {workspace} behalten",
    "projectSettings.deleteKeepHint": "Sie bleiben, wie sie sind, ohne Projekt.",
    "projectSettings.deleteAlso": "Ebenfalls löschen",
    "projectSettings.deleteAlsoHint": "Gelöschte Chats lassen sich nicht wiederherstellen.",
    "projectSettings.deleteConfirm": "Projekt löschen",
    "projectSettings.failed": "Das hat nicht geklappt. Versuch es noch einmal.",
    "projectSettings.busy":
      "Ein Chat in diesem Projekt arbeitet noch. Versuch es noch einmal, wenn er fertig ist.",
    "projectSettings.stayPrivate":
      "Ein Chat in diesem Projekt enthält personenbezogene Daten oder liest einen Datenspeicher und bleibt privat.",
    "projectSettings.othersChats":
      "Im Projekt liegen Chats von anderen, die es dann verlassen würden. Nimm diese Chats zuerst aus dem Projekt.",
    "projectSettings.memberOnly":
      "Nur wer in beiden Arbeitsbereichen Mitglied ist, verschiebt ein Projekt.",
    "projectSettings.changed":
      "Wer das Projekt sieht, hat sich inzwischen geändert. Schließ den Dialog und sieh noch einmal nach.",
    "projectSettings.deleteChatsOff": "Chats löschen ist hier ausgeschaltet. Behalte sie stattdessen."
  }
});
