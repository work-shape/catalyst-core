import { defineTranslations } from "./translation-area";

export const conversation = defineTranslations({
  en: {
    confirmDeleteConversation: "Delete",
    conversationExpiresOn: "Will be deleted automatically on {date}",
    conversationExpiresShortly: "Will be deleted shortly",
    conversationExpiresSoon: "will be deleted soon",
    conversationFailed: "Failed",
    conversationOptions: "Conversation options for {title}",
    conversationPrivate: "Private, only you can open it",
    conversationUnread: "New response",
    renameConversationField: "Conversation title",
    renameConversationMenuItem: "Rename conversation",
    deleteConversationDialogDescription:
      'This will permanently delete "{title}", its messages, and all attached files.',
    deleteConversationDialogTitle: "Delete conversation?",
    deleteConversationMenuItem: "Delete conversation",
    deleteFailed: "Delete failed"
  },
  de: {
    confirmDeleteConversation: "Löschen",
    conversationExpiresOn: "Wird am {date} automatisch gelöscht",
    conversationExpiresShortly: "Wird in Kürze gelöscht",
    conversationExpiresSoon: "wird bald gelöscht",
    conversationFailed: "Fehlgeschlagen",
    conversationOptions: "Optionen für Unterhaltung {title}",
    conversationPrivate: "Privat, nur du kannst sie öffnen",
    conversationUnread: "Neue Antwort",
    renameConversationField: "Titel der Unterhaltung",
    renameConversationMenuItem: "Unterhaltung umbenennen",
    deleteConversationDialogDescription:
      '"{title}", alle Nachrichten und alle angehängten Dateien werden dauerhaft gelöscht.',
    deleteConversationDialogTitle: "Unterhaltung löschen?",
    deleteConversationMenuItem: "Unterhaltung löschen",
    deleteFailed: "Löschen fehlgeschlagen"
  }
});
