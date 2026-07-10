import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import {
  createRoute,
  createRootRoute,
  createRouter,
  redirect,
  RouterProvider,
  useLocation,
  useRouter
} from "@tanstack/react-router";
import { ChatShell, type ChatShellAdminPanel } from "./chat-shell";
import type { ToolDisplayWidgetRegistry } from "./domain-ui-widgets";
import type {
  SuperadminRouteTab,
  WorkspaceRoute,
  WorkspaceRouteChangeOptions
} from "./workspace-route";

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

  const router = createStandaloneChatRouter({
    apiBaseUrl: resolveApiBaseUrl(apiBaseUrl, defaultApiPort),
    adminPanel,
    displayWidgets
  });

  createRoot(rootElement).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>
  );
}

interface StandaloneChatRouterOptions {
  apiBaseUrl: string;
  adminPanel?: ChatShellAdminPanel;
  displayWidgets?: ToolDisplayWidgetRegistry;
}

function createStandaloneChatRouter(options: StandaloneChatRouterOptions) {
  const rootRoute = createRootRoute({
    component: () => <StandaloneChatRouteBridge options={options} />
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/"
  });
  const conversationRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "c/$conversationId"
  });
  const settingsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "settings"
  });
  const adminIndexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "admin",
    beforeLoad: () => {
      throw redirect({ to: "/admin/usage" });
    }
  });
  const adminUsageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "admin/usage"
  });
  const adminUsersRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "admin/users"
  });
  const adminAuditRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "admin/audit"
  });
  const adminConfigRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "admin/config"
  });
  const routeTree = rootRoute.addChildren([
    indexRoute,
    conversationRoute,
    settingsRoute,
    adminIndexRoute,
    adminUsageRoute,
    adminUsersRoute,
    adminAuditRoute,
    adminConfigRoute
  ]);

  return createRouter({
    routeTree
  });
}

function StandaloneChatRouteBridge({ options }: { options: StandaloneChatRouterOptions }) {
  const router = useRouter();
  const location = useLocation();
  const route = workspaceRouteFromPath(location.pathname);

  function onRouteChange(nextRoute: WorkspaceRoute, navigationOptions?: WorkspaceRouteChangeOptions) {
    void router.navigate({
      ...workspaceRouteNavigation(nextRoute),
      replace: navigationOptions?.replace
    });
  }

  return (
    <ChatShell
      apiBaseUrl={options.apiBaseUrl}
      adminPanel={options.adminPanel}
      displayWidgets={options.displayWidgets}
      manageDocumentTitle
      route={route}
      onRouteChange={onRouteChange}
    />
  );
}

function workspaceRouteNavigation(route: WorkspaceRoute) {
  if (route.kind === "conversation") {
    return {
      to: "/c/$conversationId",
      params: { conversationId: route.conversationId }
    };
  }
  if (route.kind === "settings") {
    return { to: "/settings" };
  }
  if (route.kind === "superadmin") {
    return { to: `/admin/${route.tab}` };
  }
  return { to: "/" };
}

function workspaceRouteFromPath(pathname: string): WorkspaceRoute {
  const normalizedPathname = normalizePathname(pathname);
  if (normalizedPathname.startsWith("/c/")) {
    const encodedConversationId = normalizedPathname.slice("/c/".length);
    if (encodedConversationId && !encodedConversationId.includes("/")) {
      return {
        kind: "conversation",
        conversationId: decodePathSegment(encodedConversationId)
      };
    }
  }
  if (normalizedPathname === "/settings") {
    return { kind: "settings" };
  }
  if (normalizedPathname.startsWith("/admin/")) {
    const tab = normalizedPathname.slice("/admin/".length);
    if (isSuperadminRouteTab(tab)) {
      return { kind: "superadmin", tab };
    }
  }
  return { kind: "new-conversation" };
}

function normalizePathname(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isSuperadminRouteTab(value: string): value is SuperadminRouteTab {
  return value === "usage" || value === "users" || value === "audit" || value === "config";
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
