import { defineTranslations } from "./translation-area";

/** The Inbox: its lists, an item's frame and the words of the item kinds. */
export const inbox = defineTranslations({
  en: {
    "inbox.comment": "Comment",
    "inbox.commentRequired": "Write what should change before you request changes.",
    "inbox.decided": "Decided",
    "inbox.emptyDecided": "Nothing was decided in the last 30 days.",
    "inbox.emptyItem": "Select a request to read it.",
    "inbox.emptyMyRequests":
      "You have not requested anything that needs a decision. When an agent needs someone's approval, it shows up here.",
    "inbox.emptyToDecide": "Nothing to decide.",
    "inbox.kindSkillChange": "Skill change",
    "inbox.kindUnknown": "Request",
    "inbox.loadFailed": "The requests could not be loaded.",
    "inbox.myRequests": "My requests",
    "inbox.openConversation": "Open conversation",
    "inbox.railCount": "Inbox, {count} to decide",
    "inbox.revertTitle": "Undo this change?",
    "inbox.showList": "Show list",
    "inbox.tabs": "Lists of the Inbox",
    "inbox.toDecide": "To decide",
    "inbox.unknownKind": "This item cannot be shown here yet.",
    "inbox.via": "via {agent}"
  },
  de: {
    "inbox.comment": "Kommentar",
    "inbox.commentRequired": "Schreibe, was sich ändern soll, bevor du eine Änderung anfragst.",
    "inbox.decided": "Entschieden",
    "inbox.emptyDecided": "In den letzten 30 Tagen wurde nichts entschieden.",
    "inbox.emptyItem": "Wähle eine Anfrage aus, um sie zu lesen.",
    "inbox.emptyMyRequests":
      "Du hast nichts angefragt, das eine Entscheidung braucht. Wenn ein Agent die Freigabe von jemandem braucht, erscheint sie hier.",
    "inbox.emptyToDecide": "Nichts zu entscheiden.",
    "inbox.kindSkillChange": "Änderung einer Fähigkeit",
    "inbox.kindUnknown": "Anfrage",
    "inbox.loadFailed": "Die Anfragen konnten nicht geladen werden.",
    "inbox.myRequests": "Meine Anfragen",
    "inbox.openConversation": "Unterhaltung öffnen",
    "inbox.railCount": "Eingang, {count} zu entscheiden",
    "inbox.revertTitle": "Diese Änderung rückgängig machen?",
    "inbox.showList": "Liste anzeigen",
    "inbox.tabs": "Listen im Eingang",
    "inbox.toDecide": "Zu entscheiden",
    "inbox.unknownKind": "Dieser Eintrag kann hier noch nicht angezeigt werden.",
    "inbox.via": "über {agent}"
  }
});
