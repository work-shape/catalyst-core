import type { LocaleCode } from "@vivd-catalyst/api-client";

export const workspaceQueryKeys = {
  me: (apiBaseUrl: string) => ["me", apiBaseUrl] as const,
  branding: (apiBaseUrl: string, localePreference: LocaleCode | undefined) =>
    ["branding", apiBaseUrl, localePreference ?? "auto"] as const,
  config: (
    apiBaseUrl: string,
    authScope: string,
    localePreference: LocaleCode | undefined
  ) => ["config", apiBaseUrl, authScope, localePreference ?? "auto"] as const,
  conversations: (apiBaseUrl: string, authScope: string) =>
    ["conversations", apiBaseUrl, authScope] as const,
  thread: (
    apiBaseUrl: string,
    authScope: string,
    conversationId: string | undefined
  ) => ["thread", apiBaseUrl, authScope, conversationId] as const,
  draftAttachmentsScope: (apiBaseUrl: string, authScope: string) =>
    ["draft-attachments", apiBaseUrl, authScope] as const,
  draftAttachments: (
    apiBaseUrl: string,
    authScope: string,
    conversationId: string | undefined
  ) => ["draft-attachments", apiBaseUrl, authScope, conversationId] as const,
  usage: (apiBaseUrl: string, authScope: string) => ["usage", apiBaseUrl, authScope] as const,
  auditEvents: (apiBaseUrl: string, authScope: string) =>
    ["audit-events", apiBaseUrl, authScope] as const,
  superadminUsers: (apiBaseUrl: string, authScope: string) =>
    ["superadmin-users", apiBaseUrl, authScope] as const
};
