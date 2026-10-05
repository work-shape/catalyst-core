export type SuperadminRouteTab = "usage" | "users" | "api-access" | "audit" | "config";
export type WorkspaceRouteView = "chat" | "settings" | "superadmin" | "approvals";

/**
 * `collaboration-workspace-root` and `legacy-conversation` are unresolved chat
 * routes: the active Collaboration Workspace is not in the URL yet, so the chat
 * model resolves it and replaces the route with a canonical `/w/...` one.
 */
export type WorkspaceRoute =
  | { kind: "collaboration-workspace-root" }
  | { kind: "legacy-conversation"; conversationId: string }
  | { kind: "new-conversation"; collaborationWorkspaceId: string }
  | { kind: "conversation"; collaborationWorkspaceId: string; conversationId: string }
  | { kind: "settings" }
  | { kind: "approvals" }
  | { kind: "superadmin"; tab: SuperadminRouteTab };

export interface WorkspaceRouteChangeOptions {
  replace?: boolean;
}

export function defaultWorkspaceRoute(): WorkspaceRoute {
  return { kind: "collaboration-workspace-root" };
}

export function collaborationWorkspaceHomeRoute(collaborationWorkspaceId: string): WorkspaceRoute {
  return { kind: "new-conversation", collaborationWorkspaceId };
}

export function routeCollaborationWorkspaceId(route: WorkspaceRoute): string | undefined {
  return route.kind === "new-conversation" || route.kind === "conversation"
    ? route.collaborationWorkspaceId
    : undefined;
}

export function routeConversationId(route: WorkspaceRoute): string | undefined {
  return route.kind === "conversation" || route.kind === "legacy-conversation"
    ? route.conversationId
    : undefined;
}

export function isChatWorkspaceRoute(route: WorkspaceRoute): boolean {
  return workspaceRouteView(route) === "chat";
}

export function workspaceRouteView(route: WorkspaceRoute): WorkspaceRouteView {
  if (route.kind === "settings") {
    return "settings";
  }
  if (route.kind === "superadmin") {
    return "superadmin";
  }
  if (route.kind === "approvals") {
    return "approvals";
  }
  return "chat";
}
