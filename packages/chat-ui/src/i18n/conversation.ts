import { defineTranslations } from "./translation-area";

export const conversation = defineTranslations({
  en: {
    agentSurfaceMissing: "This agent is not available to you.",
    agentSurfaceOpenBuild: "Open the agent in Build",
    agentSurfaceReadOnly:
      "Saved revision {number}, shown read-only. A saved change of an agent is live at once; a person changes it in Build.",
    confirmDeleteConversation: "Delete",
    conversationExpiresOn: "Will be deleted automatically on {date}",
    conversationExpiresShortly: "Will be deleted shortly",
    conversationExpiresSoon: "will be deleted soon",
    conversationFailed: "Failed",
    conversationOptions: "Conversation options for {title}",
    conversationPrivate: "Private, only you can open it",
    conversationRetentionNotice: "{hint}.",
    conversationRetentionNoticeKeptByMessage: "{hint}. A new message keeps this conversation.",
    conversationSubjectOther: "This conversation is about “{name}”.",
    conversationSubjectWorkflow: "The agent edits the workflow",
    conversationSubjectApp: "The agent edits the app",
    conversationSubjectAgent: "The agent edits the agent",
    conversationSubjectShow: "Show",
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
    agentSurfaceMissing: "Dieser Agent ist für dich nicht verfügbar.",
    agentSurfaceOpenBuild: "Agenten in Build öffnen",
    agentSurfaceReadOnly:
      "Gespeicherte Revision {number}, nur zum Lesen. Eine gespeicherte Änderung eines Agenten gilt sofort; geändert wird er in Build.",
    confirmDeleteConversation: "Löschen",
    conversationExpiresOn: "Wird am {date} automatisch gelöscht",
    conversationExpiresShortly: "Wird in Kürze gelöscht",
    conversationExpiresSoon: "wird bald gelöscht",
    conversationFailed: "Fehlgeschlagen",
    conversationOptions: "Optionen für Unterhaltung {title}",
    conversationPrivate: "Privat, nur du kannst sie öffnen",
    conversationRetentionNotice: "{hint}.",
    conversationRetentionNoticeKeptByMessage:
      "{hint}. Mit einer neuen Nachricht bleibt diese Unterhaltung erhalten.",
    conversationSubjectOther: "In dieser Unterhaltung geht es um „{name}“.",
    conversationSubjectWorkflow: "Der Agent bearbeitet den Workflow",
    conversationSubjectApp: "Der Agent bearbeitet die App",
    conversationSubjectAgent: "Der Agent bearbeitet den Agenten",
    conversationSubjectShow: "Anzeigen",
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
