import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Outlet, RouterProvider, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { superadminPanel } from "@vivd-catalyst/chat-ui/admin";
import { ChatShell } from "@vivd-catalyst/chat-ui/shell";
import "@vivd-catalyst/chat-ui/styles.css";

const apiBaseUrl = import.meta.env.VITE_CHAT_API_URL ?? defaultLocalApiBaseUrl();
const rootRoute = createRootRoute({
  component: StandaloneRoot
});
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: StandaloneChatRoute
});
const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chat",
  component: StandaloneChatRoute
});
const routeTree = rootRoute.addChildren([indexRoute, chatRoute]);
const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>
);

function StandaloneRoot() {
  return <Outlet />;
}

function StandaloneChatRoute() {
  return <ChatShell apiBaseUrl={apiBaseUrl} adminPanel={superadminPanel} manageDocumentTitle />;
}

function defaultLocalApiBaseUrl(): string {
  return `${window.location.protocol}//${window.location.hostname}:4100`;
}
