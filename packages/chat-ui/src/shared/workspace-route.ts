import { areaOfRoute, type WorkspaceRoute, type WorkspaceRouteView } from "./routes";

export type { WorkspaceRoute, WorkspaceRouteView } from "./routes";

/**
 * The movement between the chat route and a page with the chat dock. `dock-in`: the
 * conversation of the chat route narrows into the dock of a page. `dock-out`: the dock's
 * conversation widens into its chat route.
 */
export type DockMotion = "dock-in" | "dock-out";

export interface WorkspaceRouteChangeOptions {
  replace?: boolean;
  /**
   * The conversation of the chat dock at the next address, carried as `?chat=`. The shell
   * names it on every change; the chat route has none.
   */
  chat?: string;
  /** The movement the change plays, for a host that plays it as a view transition. */
  motion?: DockMotion;
}

export function defaultWorkspaceRoute(): WorkspaceRoute {
  return { kind: "collaboration-workspace-root" };
}

export function collaborationWorkspaceHomeRoute(collaborationWorkspaceId: string): WorkspaceRoute {
  return { kind: "new-conversation", collaborationWorkspaceId };
}

export function routeCollaborationWorkspaceId(route: WorkspaceRoute): string | undefined {
  return "collaborationWorkspaceId" in route ? route.collaborationWorkspaceId : undefined;
}

export function routeConversationId(route: WorkspaceRoute): string | undefined {
  return route.kind === "conversation" ||
    route.kind === "legacy-conversation" ||
    route.kind === "subagent-thread"
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
