import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Outlet, RouterProvider, createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { superadminPanel } from "@agent-chat-platform/chat-ui/admin";
import { ChatShell } from "@agent-chat-platform/chat-ui/shell";
import "@agent-chat-platform/chat-ui/styles.css";

const apiBaseUrl = import.meta.env.VITE_CHAT_API_URL ?? "http://127.0.0.1:4100";
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
