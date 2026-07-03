import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { LocaleCode } from "@vivd-catalyst/api-client";

type TranslationValues = Record<string, string | number>;

const translations = {
  en: {
    account: "Account",
    accountMenuLabel: "{label} account",
    addAttachment: "Add attachment",
    agentFallback: "Agent",
    agentReady: "{agent} is ready for this conversation.",
    allStatuses: "All statuses",
    artifactPreviewFailed: "Preview failed",
    artifactPreviewLoading: "Loading preview",
    artifactPreviewRetry: "Retry preview",
    artifactPreviewRetrying: "Retrying",
    artifactPreviewUnavailable: "Preview unavailable",
    artifactPreviewUnsupported: "This file type is not supported by the first preview version.",
    attachmentsUnavailable: "Attachments will be available when file acquisition is implemented",
    cancel: "Cancel",
    checkingSession: "Checking session",
    closeSidebar: "Close sidebar",
    closeDisplayPanel: "Close display panel",
    collapseDisplay: "Collapse display",
    conversations: "Conversations",
    copy: "Copy",
    couldNotVerifySession: "Could not verify your session",
    confirmPassword: "Confirm password",
    confirmDeleteAccount: "Delete account",
    confirmDeleteConversation: "Delete",
    conversationFailed: "Failed",
    conversationOptions: "Conversation options for {title}",
    conversationRunning: "Running",
    conversationStillRunning: "Wait for the current response to finish",
    conversationUnread: "New response",
    currentPassword: "Current password",
    deleting: "Deleting",
    deleteAccount: "Delete account",
    deleteAccountDescription:
      "Permanently removes your user profile, sign-in identities, conversations, messages, and attached files.",
    deleteAccountDialogDescription:
      "This will permanently delete your account data in this chat. This action cannot be undone.",
    deleteAccountDialogTitle: "Delete account?",
    deleteConversationDialogDescription:
      "This will permanently delete \"{title}\", its messages, and all attached files.",
    deleteConversationDialogTitle: "Delete conversation?",
    deleteConversationMenuItem: "Delete conversation",
    deleteFailed: "Delete failed",
    accountDeleteFailed: "Account deletion failed",
    downloadArtifact: "Download {filename}",
    downloadArtifactButton: "Download",
    downloadUnavailable: "Download unavailable",
    displayName: "Display name",
    displayNameRequired: "Display name is required",
    displayPanelFallbackTitle: "Display",
    editMessage: "Edit message",
    email: "Email",
    genericWelcome: "How can I help?",
    language: "Language",
    localeDe: "Deutsch",
    localeEn: "English",
    loadingConversation: "Loading conversation",
    loadingUser: "Loading",
    messagePlaceholder: "Message",
    newConversation: "New",
    newPassword: "New password",
    newPasswordsDoNotMatch: "New passwords do not match",
    newPasswordTooShort: "New password must be at least 8 characters",
    noConversations: "No conversations yet.",
    openArtifactPreview: "Open preview for {filename}",
    openSidebar: "Open sidebar",
    openSuperadminPanel: "Open administration panel",
    openDisplayPanel: "Open in side panel",
    expandDisplay: "Expand display",
    shownInSidePanel: "Shown in side panel",
    password: "Password",
    passwordChangeUnavailable: "Password changes are not available for this account",
    passwordManagedExternally: "Password is managed outside this chat.",
    passwordUpdated: "Password updated",
    passwordUpdateFailed: "Password update failed",
    profile: "Profile",
    profileUpdateFailed: "Profile update failed",
    profileUpdated: "Profile updated",
    regenerateResponse: "Regenerate response",
    returnToChat: "Return to chat",
    resizeDisplayPanel: "Resize display panel",
    saveProfile: "Save profile",
    saving: "Saving",
    scrollToBottom: "Scroll to bottom",
    selectAgent: "Select agent",
    sendMessage: "Send message",
    sessionCheckingDescription: "Your account is being checked before the chat loads.",
    settings: "Settings",
    signIn: "Sign in",
    signInFailed: "Sign in failed",
    signInTo: "Sign in to {clientName}",
    signingIn: "Signing in",
    signOut: "Sign out",
    signingOut: "Signing out",
    stopGenerating: "Stop generating",
    structuredOutput: "Structured output: {name}",
    switchToDarkTheme: "Switch to dark theme",
    switchToLightTheme: "Switch to light theme",
    thinking: "Thinking",
    toolCallCount: "{count} tool calls",
    toolCallCountSingular: "1 tool call",
    toolCompleted: "Completed",
    toolDetails: "Details",
    toolFailed: "Failed",
    toolInput: "Input",
    toolOutput: "Output",
    toolRunning: "Running",
    workStepCount: "{count} work steps",
    workStepCountSingular: "1 work step",
    workspaceCommandCancelled: "The workspace step was cancelled before it completed.",
    workspaceCommandFailed: "The workspace step did not finish successfully. The agent can adjust the file workflow and try again.",
    workspaceCommandTimedOut: "The workspace step timed out. The agent can retry with a smaller or simpler step.",
    update: "Update",
    updatePassword: "Update password",
    updating: "Updating",
    updatedRecently: "Updated recently",
    userFallback: "User",
    userSettings: "User settings"
  },
  de: {
    account: "Konto",
    accountMenuLabel: "Konto von {label}",
    addAttachment: "Anhang hinzufügen",
    agentFallback: "Agent",
    agentReady: "{agent} ist für diese Unterhaltung bereit.",
    allStatuses: "Alle Status",
    artifactPreviewFailed: "Vorschau fehlgeschlagen",
    artifactPreviewLoading: "Vorschau wird geladen",
    artifactPreviewRetry: "Vorschau erneut versuchen",
    artifactPreviewRetrying: "Versucht erneut",
    artifactPreviewUnavailable: "Vorschau nicht verfügbar",
    artifactPreviewUnsupported: "Dieser Dateityp wird von der ersten Vorschauversion nicht unterstützt.",
    attachmentsUnavailable: "Anhänge sind verfügbar, sobald die Dateierfassung implementiert ist",
    cancel: "Abbrechen",
    checkingSession: "Sitzung wird geprüft",
    closeSidebar: "Seitenleiste schließen",
    closeDisplayPanel: "Ansicht schließen",
    collapseDisplay: "Ansicht einklappen",
    conversations: "Unterhaltungen",
    copy: "Kopieren",
    couldNotVerifySession: "Sitzung konnte nicht geprüft werden",
    confirmPassword: "Passwort bestätigen",
    confirmDeleteAccount: "Konto löschen",
    confirmDeleteConversation: "Löschen",
    conversationFailed: "Fehlgeschlagen",
    conversationOptions: "Optionen für Unterhaltung {title}",
    conversationRunning: "Läuft",
    conversationStillRunning: "Warte, bis die aktuelle Antwort fertig ist",
    conversationUnread: "Neue Antwort",
    currentPassword: "Aktuelles Passwort",
    deleting: "Löscht",
    deleteAccount: "Konto löschen",
    deleteAccountDescription:
      "Löscht dein Benutzerprofil, Anmeldeidentitäten, Unterhaltungen, Nachrichten und angehängte Dateien dauerhaft.",
    deleteAccountDialogDescription:
      "Deine Kontodaten in diesem Chat werden dauerhaft gelöscht. Diese Aktion kann nicht rückgängig gemacht werden.",
    deleteAccountDialogTitle: "Konto löschen?",
    deleteConversationDialogDescription:
      "\"{title}\", alle Nachrichten und alle angehängten Dateien werden dauerhaft gelöscht.",
    deleteConversationDialogTitle: "Unterhaltung löschen?",
    deleteConversationMenuItem: "Unterhaltung löschen",
    deleteFailed: "Löschen fehlgeschlagen",
    accountDeleteFailed: "Kontolöschung fehlgeschlagen",
    downloadArtifact: "{filename} herunterladen",
    downloadArtifactButton: "Herunterladen",
    downloadUnavailable: "Download nicht verfügbar",
    displayName: "Anzeigename",
    displayNameRequired: "Anzeigename ist erforderlich",
    displayPanelFallbackTitle: "Ansicht",
    editMessage: "Nachricht bearbeiten",
    email: "E-Mail",
    genericWelcome: "Wie kann ich helfen?",
    language: "Sprache",
    localeDe: "Deutsch",
    localeEn: "English",
    loadingConversation: "Unterhaltung wird geladen",
    loadingUser: "Lädt",
    messagePlaceholder: "Nachricht",
    newConversation: "Neu",
    newPassword: "Neues Passwort",
    newPasswordsDoNotMatch: "Neue Passwörter stimmen nicht überein",
    newPasswordTooShort: "Neues Passwort muss mindestens 8 Zeichen lang sein",
    noConversations: "Noch keine Unterhaltungen.",
    openArtifactPreview: "Vorschau für {filename} öffnen",
    openSidebar: "Seitenleiste öffnen",
    openSuperadminPanel: "Administrationsbereich öffnen",
    openDisplayPanel: "In Seitenansicht öffnen",
    expandDisplay: "Ansicht ausklappen",
    shownInSidePanel: "In Seitenansicht geöffnet",
    password: "Passwort",
    passwordChangeUnavailable: "Passwortänderungen sind für dieses Konto nicht verfügbar",
    passwordManagedExternally: "Das Passwort wird außerhalb dieses Chats verwaltet.",
    passwordUpdated: "Passwort aktualisiert",
    passwordUpdateFailed: "Passwortaktualisierung fehlgeschlagen",
    profile: "Profil",
    profileUpdateFailed: "Profilaktualisierung fehlgeschlagen",
    profileUpdated: "Profil aktualisiert",
    regenerateResponse: "Antwort neu generieren",
    returnToChat: "Zurück zum Chat",
    resizeDisplayPanel: "Breite der Seitenansicht anpassen",
    saveProfile: "Profil speichern",
    saving: "Speichert",
    scrollToBottom: "Zum Ende scrollen",
    selectAgent: "Agent auswählen",
    sendMessage: "Nachricht senden",
    sessionCheckingDescription: "Dein Konto wird geprüft, bevor der Chat geladen wird.",
    settings: "Einstellungen",
    signIn: "Anmelden",
    signInFailed: "Anmeldung fehlgeschlagen",
    signInTo: "Bei {clientName} anmelden",
    signingIn: "Anmeldung läuft",
    signOut: "Abmelden",
    signingOut: "Abmeldung läuft",
    stopGenerating: "Generierung stoppen",
    structuredOutput: "Strukturierte Ausgabe: {name}",
    switchToDarkTheme: "Zum dunklen Design wechseln",
    switchToLightTheme: "Zum hellen Design wechseln",
    thinking: "Denke nach",
    toolCallCount: "{count} Tool-Aufrufe",
    toolCallCountSingular: "1 Tool-Aufruf",
    toolCompleted: "Abgeschlossen",
    toolDetails: "Details",
    toolFailed: "Fehlgeschlagen",
    toolInput: "Eingabe",
    toolOutput: "Ausgabe",
    toolRunning: "Läuft",
    workStepCount: "{count} Arbeitsschritte",
    workStepCountSingular: "1 Arbeitsschritt",
    workspaceCommandCancelled: "Der Workspace-Schritt wurde abgebrochen, bevor er abgeschlossen war.",
    workspaceCommandFailed: "Der Workspace-Schritt wurde nicht erfolgreich abgeschlossen. Der Agent kann den Dateischritt anpassen und erneut versuchen.",
    workspaceCommandTimedOut: "Der Workspace-Schritt hat das Zeitlimit erreicht. Der Agent kann es mit einem kleineren oder einfacheren Schritt erneut versuchen.",
    update: "Aktualisieren",
    updatePassword: "Passwort aktualisieren",
    updating: "Aktualisiert",
    updatedRecently: "Gerade aktualisiert",
    userFallback: "Benutzer",
    userSettings: "Benutzereinstellungen"
  }
} satisfies Record<LocaleCode, Record<string, string>>;

type TranslationKey = keyof (typeof translations)["en"];

export interface TranslationContextValue {
  locale: LocaleCode;
  t(key: TranslationKey, values?: TranslationValues): string;
  localeName(locale: LocaleCode): string;
}

const defaultTranslationContext = createTranslationContext("en");
const TranslationContext = createContext<TranslationContextValue>(defaultTranslationContext);

export function TranslationProvider({
  locale,
  children
}: {
  locale: LocaleCode;
  children: ReactNode;
}) {
  const value = useMemo(() => createTranslationContext(locale), [locale]);
  return <TranslationContext.Provider value={value}>{children}</TranslationContext.Provider>;
}

export function useTranslation(): TranslationContextValue {
  return useContext(TranslationContext);
}

export function normalizeUiLocale(value: string | undefined): LocaleCode | undefined {
  const locale = value?.trim().toLowerCase().replace(/_/gu, "-").split("-")[0];
  return locale === "en" || locale === "de" ? locale : undefined;
}

export function readBrowserLocale(): LocaleCode | undefined {
  for (const language of window.navigator.languages ?? [window.navigator.language]) {
    const locale = normalizeUiLocale(language);
    if (locale) {
      return locale;
    }
  }
  return undefined;
}

function createTranslationContext(locale: LocaleCode): TranslationContextValue {
  return {
    locale,
    t(key, values) {
      return interpolate(translations[locale][key] ?? translations.en[key], values);
    },
    localeName(targetLocale) {
      return translations[locale][`locale${targetLocale === "de" ? "De" : "En"}`];
    }
  };
}

function interpolate(message: string, values: TranslationValues | undefined): string {
  if (!values) {
    return message;
  }

  return Object.entries(values).reduce(
    (currentMessage, [name, value]) => currentMessage.replaceAll(`{${name}}`, String(value)),
    message
  );
}
