import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ChatShell, type ChatShellAdminPanel } from "./chat-shell";
import type { ToolDisplayWidgetRegistry } from "./domain-ui-widgets";

export interface StandaloneChatAppOptions {
  apiBaseUrl?: string;
  defaultApiPort?: string | number;
  adminPanel?: ChatShellAdminPanel;
  displayWidgets?: ToolDisplayWidgetRegistry;
  rootElement?: HTMLElement | null;
}

export function renderStandaloneChatApp({
  apiBaseUrl,
  defaultApiPort,
  adminPanel,
  displayWidgets,
  rootElement = document.getElementById("root")
}: StandaloneChatAppOptions): void {
  if (!rootElement) {
    throw new Error("Missing root element for standalone chat app");
  }

  createRoot(rootElement).render(
    <StrictMode>
      <ChatShell
        apiBaseUrl={resolveApiBaseUrl(apiBaseUrl, defaultApiPort)}
        adminPanel={adminPanel}
        displayWidgets={displayWidgets}
        manageDocumentTitle
      />
    </StrictMode>
  );
}

function resolveApiBaseUrl(apiBaseUrl: string | undefined, defaultApiPort: string | number | undefined): string {
  if (apiBaseUrl) {
    return apiBaseUrl;
  }
  if (defaultApiPort) {
    return defaultLocalApiBaseUrl(defaultApiPort);
  }
  return apiBaseUrl ?? defaultLocalApiBaseUrl(4100);
}

function defaultLocalApiBaseUrl(port: string | number): string {
  return `${window.location.protocol}//${window.location.hostname}:${port}`;
}
