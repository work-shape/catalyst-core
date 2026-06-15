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
    attachmentsUnavailable: "Attachments will be available when file acquisition is implemented",
    cancel: "Cancel",
    checkingSession: "Checking session",
    closeSidebar: "Close sidebar",
    conversations: "Conversations",
    copy: "Copy",
    couldNotVerifySession: "Could not verify your session",
    confirmPassword: "Confirm password",
    currentPassword: "Current password",
    deleteConversation: "Delete conversation {title}",
    deleteFailed: "Delete failed",
    displayName: "Display name",
    displayNameRequired: "Display name is required",
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
    openSidebar: "Open sidebar",
    openSuperadminPanel: "Open superadmin panel",
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
    toolCompleted: "Completed",
    toolDetails: "Details",
    toolFailed: "Failed",
    toolRunning: "Running",
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
    attachmentsUnavailable: "Anhänge sind verfügbar, sobald die Dateierfassung implementiert ist",
    cancel: "Abbrechen",
    checkingSession: "Sitzung wird geprüft",
    closeSidebar: "Seitenleiste schließen",
    conversations: "Unterhaltungen",
    copy: "Kopieren",
    couldNotVerifySession: "Sitzung konnte nicht geprüft werden",
    confirmPassword: "Passwort bestätigen",
    currentPassword: "Aktuelles Passwort",
    deleteConversation: "Unterhaltung {title} löschen",
    deleteFailed: "Löschen fehlgeschlagen",
    displayName: "Anzeigename",
    displayNameRequired: "Anzeigename ist erforderlich",
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
    openSidebar: "Seitenleiste öffnen",
    openSuperadminPanel: "Superadmin-Bereich öffnen",
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
    thinking: "Denkt nach",
    toolCompleted: "Abgeschlossen",
    toolDetails: "Details",
    toolFailed: "Fehlgeschlagen",
    toolRunning: "Läuft",
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
