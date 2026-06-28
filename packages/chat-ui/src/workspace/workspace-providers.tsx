import type { ReactNode } from "react";
import { WorkspaceApiClientProvider } from "../api/workspace-api-client";
import { ToolDisplayPanelProvider } from "../tool-display-panel";
import type { WorkspaceRoute, WorkspaceRouteChangeOptions } from "../workspace-route";
import { WorkspaceDraftsProvider } from "./workspace-drafts";
import { WorkspaceUiStateProvider } from "./workspace-ui-state";

export function WorkspaceProviders({
  apiBaseUrl,
  token,
  getToken,
  route,
  onRouteChange,
  children
}: {
  apiBaseUrl: string;
  token?: string;
  getToken?: () => string | undefined | Promise<string | undefined>;
  route: WorkspaceRoute;
  onRouteChange(route: WorkspaceRoute, options?: WorkspaceRouteChangeOptions): void;
  children: ReactNode;
}) {
  return (
    <WorkspaceApiClientProvider apiBaseUrl={apiBaseUrl} token={token} getToken={getToken}>
      <WorkspaceUiStateProvider route={route} onRouteChange={onRouteChange}>
        <WorkspaceDraftsProvider>
          <ToolDisplayPanelProvider>{children}</ToolDisplayPanelProvider>
        </WorkspaceDraftsProvider>
      </WorkspaceUiStateProvider>
    </WorkspaceApiClientProvider>
  );
}
