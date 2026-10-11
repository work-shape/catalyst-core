import { createContext, useContext, type ReactNode } from "react";
import type { WorkspaceRoute, WorkspaceRouteChangeOptions } from "../workspace/workspace-route";
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
}

const AppsHostContext = createContext<AppsHost | undefined>(undefined);

export function AppsHostProvider({ value, children }: { value: AppsHost; children: ReactNode }) {
  return <AppsHostContext.Provider value={value}>{children}</AppsHostContext.Provider>;
}

/** The host, or nothing where a Page or an App is shown outside a workspace shell. */
export function useAppsHost(): AppsHost | undefined {
  return useContext(AppsHostContext);
}
