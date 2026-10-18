import { useCallback, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ThemeMode } from "@work-shape/catalyst-ui/theme";
import type { ClientLabelOverrides } from "./shared/i18n";
import { ChatWorkspace } from "./chat-workspace";
import { createWorkspaceQueryClient } from "./shared/api/workspace-queries";
import {
  finishSessionChange,
  personIdIn,
  shellSessionFor,
  showsWorkspace,
  subscribeToShellCache,
  type ShellSession
} from "./shared/shell-session";
import {
  ToolDisplayActionsProvider,
  ToolDisplayWidgetProvider,
  type ToolDisplayWidgetRegistry
} from "./shared/domain-ui-widgets";
import type { ChatShellAdministration } from "./shared/page-definition";
import {
  defaultWorkspaceRoute,
  type WorkspaceRoute,
  type WorkspaceRouteChangeOptions
} from "./shared/workspace-route";

export interface ChatShellProps {
  apiBaseUrl: string;
  token?: string;
  getToken?: () => string | undefined | Promise<string | undefined>;
  /**
   * The administration this host ships: the Instance pages of Settings and the Build page,
   * from `@work-shape/catalyst-chat-ui/admin`. Without it the shell has neither.
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
  const session = useShellSession(workspaceProps.apiBaseUrl);
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
    <QueryClientProvider client={session.queryClient}>
      {showsWorkspace(session) ? (
        <ToolDisplayActionsProvider key={session.generation}>
          <ToolDisplayWidgetProvider widgets={displayWidgets}>
            <ChatWorkspace
              {...workspaceProps}
              route={resolvedRoute}
              chat={resolvedChat}
              onRouteChange={resolvedRouteChange}
            />
          </ToolDisplayWidgetProvider>
        </ToolDisplayActionsProvider>
      ) : null}
    </QueryClientProvider>
  );
}

/**
 * The cache the shell reads through, and the session it belongs to. A change of the person
 * signed in starts a new session in two steps: first the workspace of the person before goes,
 * then the session before ends (its cache and every store outside React cleared) and the
 * workspace mounts again under the new `generation`, before anything is painted. So the new
 * workspace never starts from what the person before left.
 */
function useShellSession(apiBaseUrl: string): ShellSession {
  const [session, setSession] = useState<ShellSession>(() => ({
    queryClient: createWorkspaceQueryClient(),
    personId: undefined,
    generation: 0
  }));
  const { queryClient } = session;
  const subscribe = useCallback(
    (listener: () => void) => subscribeToShellCache(queryClient, listener),
    [queryClient]
  );
  const personId = useSyncExternalStore(subscribe, () => personIdIn(queryClient, apiBaseUrl));
  const next = shellSessionFor(session, personId, apiBaseUrl, createWorkspaceQueryClient);
  if (next !== session) setSession(next);
  // The old workspace has gone; end its session, then mount the new one before paint.
  useLayoutEffect(() => {
    const shown = finishSessionChange(session);
    if (shown !== session) setSession((current) => (current === session ? shown : current));
  }, [session]);
  return session;
}
