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
  /** The workspace the person works in, personal or shared: where a new agent starts. */
  activeWorkspace: CollaborationWorkspaceWithRole | undefined;
  /** The person deleted their account: the session is over. */
  onAccountDeleted(): void;
  /** The person left the workspace they were changing. */
  onWorkspaceLeft(): void;
  onWorkspaceDeleted(collaborationWorkspaceId: string): void;
  /**
   * Opens the dock on this page with a new conversation with an agent that holds the platform's
   * asset tools, `prompt` in its composer: a New button's way where such an agent is offered.
   * Absent where none is: the New buttons keep their dialogs.
   */
  buildWithAgent?(prompt: string): void;
  /**
   * Opens the chat dock beside the open page with a new conversation and this text in its
   * composer, for the person to send. Absent where the shell has no dock.
   */
  startDockedChat?: (prompt: string) => void;
}

const SettingsPageContext = createContext<SettingsPageContextValue | undefined>(undefined);

export const SettingsPageProvider = SettingsPageContext.Provider;

/** The settings page's context, or nothing outside one, as in a rendering of a page alone. */
export function useOptionalSettingsPage(): SettingsPageContextValue | undefined {
  return useContext(SettingsPageContext);
}

export function useSettingsPage(): SettingsPageContextValue {
  const value = useContext(SettingsPageContext);
  if (!value) {
    throw new Error("useSettingsPage must be used within a SettingsPageProvider");
  }
  return value;
}
