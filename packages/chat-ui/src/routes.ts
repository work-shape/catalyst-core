/** The pages of the administration area. */
const superadminRouteTabs = ["usage", "users", "api-access", "audit", "config"] as const;
export type SuperadminRouteTab = (typeof superadminRouteTabs)[number];

/** The areas of the interface: what a route shows. */
export type WorkspaceRouteView = "chat" | "settings" | "superadmin" | "approvals" | "ui-library";

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
  | { kind: "superadmin"; tab: SuperadminRouteTab }
  /** The gallery of the shared UI library. Administrators reach it by address; nothing links to it. */
  | { kind: "ui-library" };

/** One address of an area: a path pattern, with `$name` for a segment that is read. */
interface AreaRoutePath {
  path: string;
  /** The route the address resolves to. Its fields are the path's parameters, by name. */
  route?: WorkspaceRoute["kind"];
  /** Where the address leads instead of resolving by itself. */
  redirectTo?: string;
}

/** One area of the interface and every address that opens it. */
interface AreaRoute {
  area: WorkspaceRouteView;
  paths: readonly AreaRoutePath[];
}

/**
 * The area route table: one row per area. The router is built from it and a path is resolved
 * by it, so no route exists outside it. A page of an area registers in that area's own catalog
 * and adds no row here; only a slice that adds or retires an area changes this table.
 */
export const areaRoutes: readonly AreaRoute[] = [
  {
    area: "chat",
    paths: [
      { path: "/", route: "collaboration-workspace-root" },
      { path: "/w/$collaborationWorkspaceId", route: "new-conversation" },
      { path: "/w/$collaborationWorkspaceId/c/$conversationId", route: "conversation" },
      { path: "/c/$conversationId", route: "legacy-conversation" }
    ]
  },
  { area: "settings", paths: [{ path: "/settings", route: "settings" }] },
  { area: "approvals", paths: [{ path: "/approvals", route: "approvals" }] },
  {
    area: "superadmin",
    paths: [
      { path: "/admin", redirectTo: "/admin/users" },
      { path: "/admin/$tab", route: "superadmin" }
    ]
  },
  { area: "ui-library", paths: [{ path: "/ui-library", route: "ui-library" }] }
];

/** Every address of the table, in the order of its rows. */
export function areaRoutePaths(): AreaRoutePath[] {
  return areaRoutes.flatMap((row) => row.paths);
}

/** The area a route belongs to: the row that holds an address of it. */
export function areaOfRoute(route: WorkspaceRoute): WorkspaceRouteView {
  const row = areaRoutes.find((candidate) =>
    candidate.paths.some((path) => path.route === route.kind)
  );
  return row?.area ?? "chat";
}

/** The route a path opens. A path no row resolves opens the application root. */
export function workspaceRouteFromPath(pathname: string): WorkspaceRoute {
  const segments = pathSegments(normalizePathname(pathname));
  for (const { path, route } of areaRoutePaths()) {
    const params = route === undefined ? undefined : matchPath(pathSegments(path), segments);
    const resolved =
      route === undefined || params === undefined ? undefined : routeOf(route, params);
    if (resolved) {
      return resolved;
    }
  }
  return { kind: "collaboration-workspace-root" };
}

/** The address of a route, as the router takes it: the row's pattern and the route's fields. */
export function workspaceRouteNavigation(route: WorkspaceRoute): {
  to: string;
  params?: Record<string, string>;
} {
  const to = areaRoutePaths().find((candidate) => candidate.route === route.kind)?.path ?? "/";
  const { kind: _kind, ...params } = route;
  return Object.keys(params).length > 0 ? { to, params } : { to };
}

function routeOf(
  kind: WorkspaceRoute["kind"],
  params: Record<string, string>
): WorkspaceRoute | undefined {
  const { collaborationWorkspaceId, conversationId, tab } = params;
  switch (kind) {
    case "collaboration-workspace-root":
    case "settings":
    case "approvals":
    case "ui-library":
      return { kind };
    case "new-conversation":
      return collaborationWorkspaceId ? { kind, collaborationWorkspaceId } : undefined;
    case "conversation":
      return collaborationWorkspaceId && conversationId
        ? { kind, collaborationWorkspaceId, conversationId }
        : undefined;
    case "legacy-conversation":
      return conversationId ? { kind, conversationId } : undefined;
    case "superadmin":
      return isSuperadminRouteTab(tab) ? { kind, tab } : undefined;
  }
}

/** The parameters of `segments` under `pattern`, or nothing when they do not match. */
function matchPath(
  pattern: readonly string[],
  segments: readonly string[]
): Record<string, string> | undefined {
  if (pattern.length !== segments.length) {
    return undefined;
  }
  const params: Record<string, string> = {};
  for (const [index, part] of pattern.entries()) {
    const segment = segments[index];
    if (!segment) {
      return undefined;
    }
    if (part.startsWith("$")) {
      params[part.slice(1)] = decodePathSegment(segment);
    } else if (part !== segment) {
      return undefined;
    }
  }
  return params;
}

function pathSegments(pathname: string): string[] {
  return pathname === "/" ? [] : pathname.slice(1).split("/");
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

function isSuperadminRouteTab(value: string | undefined): value is SuperadminRouteTab {
  return superadminRouteTabs.some((tab) => tab === value);
}
