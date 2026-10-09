import { areaOfRoute, type WorkspaceRoute, type WorkspaceRouteView } from "../routes";

export type { SuperadminRouteTab, WorkspaceRoute, WorkspaceRouteView } from "../routes";

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

/** The view a route shows: its area in the area route table. */
export function workspaceRouteView(route: WorkspaceRoute): WorkspaceRouteView {
  return areaOfRoute(route);
}
