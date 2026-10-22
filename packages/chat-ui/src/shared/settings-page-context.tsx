import { createContext, useContext } from "react";
import type {
  ApiClient,
  ApiUser,
  CollaborationWorkspaceWithRole,
  LocaleCode,
  SafeConfig
} from "@work-shape/catalyst-api-client";
import type { ThemeModePreference } from "./theme";

/**
 * The agent and the dock as the shell offers them to the Settings and Build pages. The shell
 * hands them on as one object, so a further action is a member here and changes no model in
 * between.
 */
export interface SettingsAgentActions {
  /**
   * Opens the dock on this page with a new conversation with an agent that holds the platform's
   * asset tools, `prompt` in its composer: the brief of a kind without a hand editor, and the
   * chat of a new asset's page. Absent where none is offered.
   */
  buildWithAgent?(prompt: string): void;
  /**
   * Opens the dock beside the open page with a conversation about one asset, with the agent
   * that holds the platform's asset tools: the page head's "Chat" on an asset page. The
   * conversation belongs to `workspaceId`, the workspace that owns the asset, for the agent reads
   * the asset there alone; to the open workspace where none is named, for an asset of the
   * instance. `fresh` starts a new one where the dock's is already about the asset. Absent where
   * none is offered: "Chat" then opens the dock's last conversation.
   */
  editWithAgent?(
    subject: { kind: string; name: string },
    workspaceId: string | undefined,
    options?: { fresh: boolean }
  ): Promise<void>;
  /**
   * Opens the chat dock beside the open page with a new conversation and this text in its
   * composer, for the person to send. Absent where the shell has no dock.
   */
  startDockedChat?: (prompt: string) => void;
  /**
   * Sends `text` to a conversation as the person's own message, with the agent named or the
   * conversation's own, queued behind a run that goes: the New connection dialog's word that a
   * Connection an agent proposed is connected (CHAT-CONN-1). Absent where the shell has no chat.
   */
  tellConversation?: (
    to: { conversationId: string; agentName?: string },
    text: string
  ) => Promise<void>;
}

/**
 * What the shell hands every Settings page and the Build page: the session, the instance
 * configuration, the person's own preferences and the workspace the Workspace group is
 * switched to. A page loads its own data with these.
 */
export interface SettingsPageContextValue extends SettingsAgentActions {
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
