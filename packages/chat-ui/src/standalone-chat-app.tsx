import { StrictMode, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import {
  createRoute,
  createRootRoute,
  createRouter,
  redirect,
  RouterProvider,
  useBlocker,
  useLocation,
  useRouter
} from "@tanstack/react-router";
import type { ClientLabelOverrides } from "./shared/i18n";
import { ChatShell } from "./chat-shell";
import type { ChatShellAdministration } from "./shared/page-definition";
import type { ToolDisplayWidgetRegistry } from "./shared/domain-ui-widgets";
import {
  ToolActivityLabelsProvider,
  type ToolActivityLabels
} from "./chat/assistant/tool-activity";
import { hasLeaveGuard, mayLeave, subscribeLeaveGuard } from "./shared/leave-guard";
import { installStaleChunkRecovery } from "./shared/stale-chunk-recovery";
import { applyDocumentThemeMode } from "./shared/theme";
import {
  areaRoutePaths,
  workspaceRouteFromPath,
  workspaceRouteNavigation,
  workspaceRoutePath
} from "./shared/routes";
import { dockViewTransition, dockViewTransitionsSupported } from "./chat/dock/dock-motion";
import { dockConversationOfSearch, searchWithDock } from "./chat/workspace/dock-state";
import type { WorkspaceRoute, WorkspaceRouteChangeOptions } from "./shared/workspace-route";

export interface StandaloneChatAppOptions {
  apiBaseUrl?: string;
  defaultApiPort?: string | number;
  administration?: ChatShellAdministration;
  displayWidgets?: ToolDisplayWidgetRegistry;
  labelOverrides?: ClientLabelOverrides;
  toolActivityLabels?: ToolActivityLabels;
  rootElement?: HTMLElement | null;
}

export function renderStandaloneChatApp({
  apiBaseUrl,
  defaultApiPort,
  administration,
  displayWidgets,
  labelOverrides,
  toolActivityLabels,
  rootElement = document.getElementById("root")
}: StandaloneChatAppOptions): void {
  if (!rootElement) {
    throw new Error("Missing root element for standalone chat app");
  }

  installStaleChunkRecovery();

  const router = createStandaloneChatRouter({
    apiBaseUrl: resolveApiBaseUrl(apiBaseUrl, defaultApiPort),
    administration,
    displayWidgets,
    labelOverrides,
    toolActivityLabels
  });

  createRoot(rootElement).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>
  );
}

interface StandaloneChatRouterOptions {
  apiBaseUrl: string;
  administration?: ChatShellAdministration;
  displayWidgets?: ToolDisplayWidgetRegistry;
  labelOverrides?: ClientLabelOverrides;
  toolActivityLabels?: ToolActivityLabels;
}

/** The router of the standalone app: one route per address of the area route table. */
function createStandaloneChatRouter(options: StandaloneChatRouterOptions) {
  const rootRoute = createRootRoute({
    component: () => <StandaloneChatRouteBridge options={options} />
  });
  const routeTree = rootRoute.addChildren(
    areaRoutePaths().map(({ path, redirectTo }) =>
      createRoute({
        getParentRoute: () => rootRoute,
        path,
        beforeLoad: redirectTo
          ? ({ params }) => {
              throw redirect({ to: redirectTo, params });
            }
          : undefined
      })
    )
  );

  return createRouter({
    routeTree
  });
}

function StandaloneChatRouteBridge({ options }: { options: StandaloneChatRouterOptions }) {
  const router = useRouter();
  const location = useLocation();
  const route = workspaceRouteFromPath(location.pathname);
  // The dock's conversation rides in the search; the chat route has no dock and ignores it.
  const chat = dockConversationOfSearch(location.search);
  const [viewTransitions] = useState(dockViewTransitionsSupported);
  // A page with unsaved changes is asked before any navigation, the browser's Back included.
  const guarded = useSyncExternalStore(subscribeLeaveGuard, hasLeaveGuard, () => false);
  useBlocker({
    shouldBlockFn: async () => !(await mayLeave()),
    enableBeforeUnload: false,
    disabled: !guarded
  });

  function onRouteChange(
    nextRoute: WorkspaceRoute,
    navigationOptions?: WorkspaceRouteChangeOptions
  ) {
    // On the same page the other parameters of its search stay; a new page starts without them.
    const samePage = workspaceRoutePath(nextRoute) === router.state.location.pathname;
    const viewTransition = viewTransitions
      ? dockViewTransition(navigationOptions?.motion)
      : undefined;
    void router.navigate({
      ...workspaceRouteNavigation(nextRoute),
      search: (previous: Record<string, unknown>) =>
        searchWithDock(samePage ? previous : undefined, navigationOptions?.chat),
      replace: navigationOptions?.replace,
      ...(viewTransition === undefined ? {} : { viewTransition })
    });
  }

  return (
    <ToolActivityLabelsProvider labels={options.toolActivityLabels}>
      <ChatShell
        apiBaseUrl={options.apiBaseUrl}
        administration={options.administration}
        displayWidgets={options.displayWidgets}
        labelOverrides={options.labelOverrides}
        manageDocumentTitle
        onThemeModeChange={applyDocumentThemeMode}
        route={route}
        chat={chat}
        viewTransitions={viewTransitions}
        onRouteChange={onRouteChange}
      />
    </ToolActivityLabelsProvider>
  );
}

function resolveApiBaseUrl(
  apiBaseUrl: string | undefined,
  defaultApiPort: string | number | undefined
): string {
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
