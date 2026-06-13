import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ChatShell, type ChatShellAdminPanel } from "./chat-shell";
import type { DomainUiWidgetRegistry } from "./domain-ui-widgets";

export interface StandaloneChatAppOptions {
  apiBaseUrl?: string;
  adminPanel?: ChatShellAdminPanel;
  domainUiWidgets?: DomainUiWidgetRegistry;
  rootElement?: HTMLElement | null;
}

export function renderStandaloneChatApp({
  apiBaseUrl,
  adminPanel,
  domainUiWidgets,
  rootElement = document.getElementById("root")
}: StandaloneChatAppOptions): void {
  if (!rootElement) {
    throw new Error("Missing root element for standalone chat app");
  }

  createRoot(rootElement).render(
    <StrictMode>
      <ChatShell
        apiBaseUrl={apiBaseUrl ?? defaultLocalApiBaseUrl()}
        adminPanel={adminPanel}
        domainUiWidgets={domainUiWidgets}
        manageDocumentTitle
      />
    </StrictMode>
  );
}

function defaultLocalApiBaseUrl(): string {
  return `${window.location.protocol}//${window.location.hostname}:4100`;
}
