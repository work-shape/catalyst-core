import { useState, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ApiClient, ApiUser, SafeConfig } from "@vivd-catalyst/api-client";
import { ChatWorkspace } from "./chat-workspace";
import {
  ToolDisplayActionsProvider,
  ToolDisplayWidgetProvider,
  type ToolDisplayWidgetRegistry
} from "./domain-ui-widgets";
import {
  defaultWorkspaceRoute,
  type SuperadminRouteTab,
  type WorkspaceRoute,
  type WorkspaceRouteChangeOptions
} from "./workspace/workspace-route";

export interface ChatShellAdminPanel {
  resolveRoute(input: ChatShellAdminRouteInput): ChatShellAdminRouteState;
  Panel: ComponentType<ChatShellAdminPanelInput>;
}

export interface ChatShellAdminRouteInput {
  user: ApiUser | undefined;
  configAssetManagement: SafeConfig["features"]["configAssets"] | undefined;
  requestedTab: SuperadminRouteTab | undefined;
}

export interface ChatShellAdminRouteState {
  canView: boolean;
  pending: boolean;
  selectedTab: SuperadminRouteTab | undefined;
}

export interface ChatShellAdminPanelInput {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
  user: ApiUser;
  configAssetManagement: SafeConfig["features"]["configAssets"] | undefined;
  userInvitationsEnabled: boolean;
  selectedTab: SuperadminRouteTab;
  onSelectTab(tab: SuperadminRouteTab): void;
}

export interface ChatShellProps {
  apiBaseUrl: string;
  token?: string;
  getToken?: () => string | undefined | Promise<string | undefined>;
  adminPanel?: ChatShellAdminPanel;
  displayWidgets?: ToolDisplayWidgetRegistry;
  manageDocumentTitle?: boolean;
  className?: string;
  route?: WorkspaceRoute;
  onRouteChange?: (route: WorkspaceRoute, options?: WorkspaceRouteChangeOptions) => void;
}

export function ChatShell({
  displayWidgets,
  route,
  onRouteChange,
  ...workspaceProps
}: ChatShellProps) {
  const [queryClient] = useState(() => new QueryClient());
  const [localRoute, setLocalRoute] = useState<WorkspaceRoute>(() => defaultWorkspaceRoute());
  const resolvedRoute = route ?? localRoute;
  const resolvedRouteChange = onRouteChange ?? setLocalRoute;

  return (
    <QueryClientProvider client={queryClient}>
      <ToolDisplayActionsProvider>
        <ToolDisplayWidgetProvider widgets={displayWidgets}>
          <ChatWorkspace
            {...workspaceProps}
            route={resolvedRoute}
            onRouteChange={resolvedRouteChange}
          />
        </ToolDisplayWidgetProvider>
      </ToolDisplayActionsProvider>
    </QueryClientProvider>
  );
}
