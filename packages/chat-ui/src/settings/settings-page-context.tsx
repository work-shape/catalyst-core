import { createContext, useContext } from "react";
import type {
  ApiClient,
  ApiUser,
  CollaborationWorkspaceWithRole,
  LocaleCode,
  SafeConfig
} from "@vivd-catalyst/api-client";
import type { ThemeModePreference } from "../theme";

/**
 * What the shell hands every Settings page and the Build page: the session, the instance
 * configuration, the person's own preferences and the workspace the Workspace group is
 * switched to. A page loads its own data with these.
 */
export interface SettingsPageContextValue {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
  user: ApiUser;
  config: SafeConfig;
  locales: LocaleCode[];
  locale: LocaleCode;
  selectLocale(locale: LocaleCode): void;
  showContextIndicator: boolean;
  setShowContextIndicator(visible: boolean): void;
  themePreference: ThemeModePreference;
  selectThemePreference(preference: ThemeModePreference): void;
  /** The shared workspace the Workspace pages change; absent on every other page. */
  workspace: CollaborationWorkspaceWithRole | undefined;
  /** The person deleted their account: the session is over. */
  onAccountDeleted(): void;
  /** The person left the workspace they were changing. */
  onWorkspaceLeft(): void;
  onWorkspaceDeleted(collaborationWorkspaceId: string): void;
}

const SettingsPageContext = createContext<SettingsPageContextValue | undefined>(undefined);

export const SettingsPageProvider = SettingsPageContext.Provider;

export function useSettingsPage(): SettingsPageContextValue {
  const value = useContext(SettingsPageContext);
  if (!value) {
    throw new Error("useSettingsPage must be used within a SettingsPageProvider");
  }
  return value;
}
