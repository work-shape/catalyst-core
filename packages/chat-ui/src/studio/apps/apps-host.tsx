import { createContext, useContext, type ReactNode } from "react";
import type { WorkspaceRoute, WorkspaceRouteChangeOptions } from "../../shared/workspace-route";
import type { AppRights } from "./app-model";

/** The workspace whose Apps are shown, as the screens name it. */
export interface AppsWorkspace {
  id: string;
  name: string;
  emoji?: string | null;
}

/**
 * What the workspace shell tells everything that shows or makes Apps: whether the module is
 * on, what the reader may do, which workspace is open, and how to go somewhere. The Apps area
 * reads it, and so does the Save as app control in the header of a Page.
 */
export interface AppsHost {
  /** The Apps module is on for this instance. */
  enabled: boolean;
  rights: AppRights;
  /** The open workspace. Absent while none is open. */
  workspace: AppsWorkspace | undefined;
  showRoute(route: WorkspaceRoute, options?: WorkspaceRouteChangeOptions): void;
  /** Opens a new conversation of the workspace with this text in its composer. */
  startChat(prompt: string): void;
  /**
   * Opens the dock on the list with a new conversation with an agent that builds assets and
   * `prompt` in its composer; nothing is created until its first save. Absent where no such
   * agent is offered or the reader may write no App: the empty list then opens the chat.
   */
  startNew?(prompt: string): void;
  /**
   * Starts a conversation of the open workspace about this App and opens it: its agent reads
   * and saves the App's draft, which is shown beside it. Rejects where the instance refuses
   * the conversation. Absent where no conversation can be started. `fresh` starts a new one
   * where the dock's is already about the App: the dock's "New chat".
   */
  editWithAgent?(app: string, options?: { fresh: boolean }): Promise<void>;
  /**
   * Sends the person's message to the conversation on screen, queued behind a run that goes
   * (CHAT-CONN-1): an App published from its card there tells the agent, which carries on
   * (APPCARD-1). Absent without a conversation.
   */
  tellConversation?(text: string): Promise<void>;
  /**
   * Where the runs of calls are read, Instance > Operations, and where one run is, for a
   * reader who may open that place. Absent for everybody else: nothing links to a page its
   * reader is not shown.
   */
  operations?: { href: string; runHref(runId: string): string };
}

const AppsHostContext = createContext<AppsHost | undefined>(undefined);

export function AppsHostProvider({ value, children }: { value: AppsHost; children: ReactNode }) {
  return <AppsHostContext.Provider value={value}>{children}</AppsHostContext.Provider>;
}

/** The host, or nothing where a Page or an App is shown outside a workspace shell. */
export function useAppsHost(): AppsHost | undefined {
  return useContext(AppsHostContext);
}
