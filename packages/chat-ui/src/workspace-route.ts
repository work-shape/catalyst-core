export type SuperadminRouteTab = "usage" | "users" | "audit";
export type WorkspaceRouteView = "chat" | "settings" | "superadmin";

export type WorkspaceRoute =
  | { kind: "new-conversation" }
  | { kind: "conversation"; conversationId: string }
  | { kind: "settings" }
  | { kind: "superadmin"; tab: SuperadminRouteTab };

export interface WorkspaceRouteChangeOptions {
  replace?: boolean;
}

export function defaultWorkspaceRoute(): WorkspaceRoute {
  return { kind: "new-conversation" };
}

export function workspaceRouteView(route: WorkspaceRoute): WorkspaceRouteView {
  if (route.kind === "settings") {
    return "settings";
  }
  if (route.kind === "superadmin") {
    return "superadmin";
  }
  return "chat";
}
