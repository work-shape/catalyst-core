import { useCallback, useState } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ThemeMode } from "@vivd-catalyst/ui/theme";
import type { ClientLabelOverrides } from "./i18n";
import { ChatWorkspace } from "./chat-workspace";
import { createWorkspaceQueryClient } from "./api/workspace-queries";
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
  labelOverrides?: ClientLabelOverrides;
  manageDocumentTitle?: boolean;
  /**
   * Told the light or dark mode the shell shows. An entry that owns its document uses it to
   * mark the document; an embedded shell leaves it out and never touches its host page.
   */
  onThemeModeChange?: (mode: ThemeMode) => void;
  className?: string;
  route?: WorkspaceRoute;
  /**
   * The conversation of the chat dock beside every page but the chat route, as the address
   * carries it in `?chat=`. A host with a router reads it there and writes the one each change
   * of route names.
   */
  chat?: string;
  /**
   * The host plays the dock's movement as a view transition, which each change of route names
   * in its `motion`. Without it the shell plays the movement itself.
   */
  viewTransitions?: boolean;
  onRouteChange?: (route: WorkspaceRoute, options?: WorkspaceRouteChangeOptions) => void;
}

export function ChatShell({
  displayWidgets,
  route,
  chat,
  onRouteChange,
  ...workspaceProps
}: ChatShellProps) {
  const [queryClient] = useState(createWorkspaceQueryClient);
  // A shell without a host's router keeps its address itself.
  const [localAddress, setLocalAddress] = useState<{ route: WorkspaceRoute; chat?: string }>(
    () => ({ route: defaultWorkspaceRoute() })
  );
  const hosted = route !== undefined;
  const resolvedRoute = route ?? localAddress.route;
  const resolvedChat = hosted ? chat : localAddress.chat;
  const changeLocalAddress = useCallback(
    (nextRoute: WorkspaceRoute, options?: WorkspaceRouteChangeOptions) =>
      setLocalAddress({ route: nextRoute, chat: options?.chat }),
    []
  );
  const resolvedRouteChange = onRouteChange ?? changeLocalAddress;

  return (
    <QueryClientProvider client={queryClient}>
      <ToolDisplayActionsProvider>
        <ToolDisplayWidgetProvider widgets={displayWidgets}>
          <ChatWorkspace
            {...workspaceProps}
            route={resolvedRoute}
            chat={resolvedChat}
            onRouteChange={resolvedRouteChange}
          />
        </ToolDisplayWidgetProvider>
      </ToolDisplayActionsProvider>
    </QueryClientProvider>
  );
}
