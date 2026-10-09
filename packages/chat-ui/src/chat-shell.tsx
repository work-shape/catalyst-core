import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ThemeMode } from "@vivd-catalyst/ui/theme";
import type { TranslationLabelOverrides } from "./i18n";
import { ChatWorkspace } from "./chat-workspace";
import {
  ToolDisplayActionsProvider,
  ToolDisplayWidgetProvider,
  type ToolDisplayWidgetRegistry
} from "./domain-ui-widgets";
import type { ChatShellAdministration } from "./settings/page-definition";
import {
  defaultWorkspaceRoute,
  type WorkspaceRoute,
  type WorkspaceRouteChangeOptions
} from "./workspace/workspace-route";

export interface ChatShellProps {
  apiBaseUrl: string;
  token?: string;
  getToken?: () => string | undefined | Promise<string | undefined>;
  /**
   * The administration this host ships: the Instance pages of Settings and the Build page,
   * from `@vivd-catalyst/chat-ui/admin`. Without it the shell has neither.
   */
  administration?: ChatShellAdministration;
  displayWidgets?: ToolDisplayWidgetRegistry;
  labelOverrides?: TranslationLabelOverrides;
  manageDocumentTitle?: boolean;
  /**
   * Told the light or dark mode the shell shows. An entry that owns its document uses it to
   * mark the document; an embedded shell leaves it out and never touches its host page.
   */
  onThemeModeChange?: (mode: ThemeMode) => void;
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
