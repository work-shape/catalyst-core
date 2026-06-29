import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  AdministeredUser,
  AdministeredUserIdentity,
  ApiUser,
  AuditEvent,
  CreateAdministeredUserRequest,
  UpdateAdministeredUserRequest,
  UpsertAdministeredUserIdentityRequest,
  UsageSummary
} from "@vivd-catalyst/api-client";
import { ChatWorkspace } from "./chat-workspace";
import {
  ToolDisplayWidgetProvider,
  type ToolDisplayWidgetRegistry
} from "./domain-ui-widgets";
import {
  defaultWorkspaceRoute,
  type SuperadminRouteTab,
  type WorkspaceRoute,
  type WorkspaceRouteChangeOptions
} from "./workspace-route";

export interface ChatShellAdminPanel {
  canView(user: ApiUser | undefined): boolean;
  renderPanel(input: {
    usage: UsageSummary | undefined;
    auditEvents: AuditEvent[];
    users: AdministeredUser[];
    loading: boolean;
    usersLoading: boolean;
    canViewUsageGovernance: boolean;
    error?: string;
    usersError?: string;
    usersMutating: boolean;
    onCreateUser(input: CreateAdministeredUserRequest): Promise<AdministeredUser>;
    onUpdateUser(userId: string, input: UpdateAdministeredUserRequest): Promise<AdministeredUser>;
    onUpsertUserIdentity(
      userId: string,
      input: UpsertAdministeredUserIdentityRequest
    ): Promise<AdministeredUser>;
    onDeleteUserIdentity(
      userId: string,
      identity: AdministeredUserIdentity
    ): Promise<AdministeredUser>;
    onResetUserPassword(userId: string, password: string): Promise<unknown>;
    selectedTab: SuperadminRouteTab;
    onSelectTab(tab: SuperadminRouteTab): void;
  }): ReactNode;
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

export function ChatShell({ displayWidgets, route, onRouteChange, ...workspaceProps }: ChatShellProps) {
  const [queryClient] = useState(() => new QueryClient());
  const [localRoute, setLocalRoute] = useState<WorkspaceRoute>(() => defaultWorkspaceRoute());
  const resolvedRoute = route ?? localRoute;
  const resolvedRouteChange = onRouteChange ?? setLocalRoute;

  return (
    <QueryClientProvider client={queryClient}>
      <ToolDisplayWidgetProvider widgets={displayWidgets}>
        <ChatWorkspace
          {...workspaceProps}
          route={resolvedRoute}
          onRouteChange={resolvedRouteChange}
        />
      </ToolDisplayWidgetProvider>
    </QueryClientProvider>
  );
}
