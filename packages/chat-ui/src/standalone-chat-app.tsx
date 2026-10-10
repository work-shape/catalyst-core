import { StrictMode, useSyncExternalStore } from "react";
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
import type { ClientLabelOverrides } from "./i18n";
import { ChatShell } from "./chat-shell";
import type { ChatShellAdministration } from "./settings/page-definition";
import type { ToolDisplayWidgetRegistry } from "./domain-ui-widgets";
import { ToolActivityLabelsProvider, type ToolActivityLabels } from "./assistant/tool-activity";
import { hasLeaveGuard, mayLeave, subscribeLeaveGuard } from "./leave-guard";
import { installStaleChunkRecovery } from "./stale-chunk-recovery";
import { applyDocumentThemeMode } from "./theme";
import { areaRoutePaths, workspaceRouteFromPath, workspaceRouteNavigation } from "./routes";
import type { WorkspaceRoute, WorkspaceRouteChangeOptions } from "./workspace/workspace-route";

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
          ? () => {
              throw redirect({ to: redirectTo });
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
    void router.navigate({
      ...workspaceRouteNavigation(nextRoute),
      replace: navigationOptions?.replace
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
