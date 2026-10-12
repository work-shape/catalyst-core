import { appInterfacePath, type AppMode } from "@vivd-catalyst/api-client";

/** The areas of the interface: what a route shows. */
export type WorkspaceRouteView =
  "chat" | "agents" | "apps" | "workflows" | "settings" | "inbox" | "build" | "ui-library";

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
  /** The agents a person may use in one workspace. */
  | { kind: "agents"; collaborationWorkspaceId: string }
  /** The Apps of one workspace. */
  | { kind: "apps"; collaborationWorkspaceId: string }
  /**
   * One App as its users are served it. `appPath` is the App's own route after the App's
   * address, starting with a slash; without it the App opens where it starts.
   */
  | { kind: "app"; collaborationWorkspaceId: string; app: string; appPath?: string }
  /** The draft of one App, for whoever may write it. */
  | { kind: "app-edit"; collaborationWorkspaceId: string; app: string }
  /** The Workflows of one workspace. */
  | { kind: "workflows"; collaborationWorkspaceId: string }
  /** One Workflow: what it does, and its last runs. */
  | { kind: "workflow"; collaborationWorkspaceId: string; workflow: string }
  /** Every run of one Workflow. */
  | { kind: "workflow-runs"; collaborationWorkspaceId: string; workflow: string }
  /** One run of a Workflow with its steps. */
  | { kind: "workflow-run"; collaborationWorkspaceId: string; workflow: string; run: string }
  /** One page of the Settings area. The Settings catalog knows the groups and the pages. */
  | { kind: "settings"; group: string; page: string }
  /**
   * The old administration address. It is unresolved like the chat root: the Settings area
   * replaces it with the first administration page the viewer may open.
   */
  | { kind: "administration" }
  /** One list of the Build area: every asset of a kind. `assetKind` is the kind's path segment. */
  | { kind: "build-kind"; assetKind: string }
  /** One asset of the Build area on its own page. */
  | { kind: "build-asset"; assetKind: string; name: string }
  /** The Build area without a kind: it opens the list last visited. */
  | { kind: "build" }
  /** The Inbox with its lists. */
  | { kind: "inbox" }
  /** The Inbox with one item open beside the lists. */
  | { kind: "inbox-item"; itemId: string }
  /** The gallery of the shared UI library. Administrators reach it by address; nothing links to it. */
  | { kind: "ui-library" }
  /** The Workflow screens on sample data, beside the UI library and for the same readers. */
  | { kind: "workflow-samples" };

/** One address of an area: a path pattern, with `$name` for a segment that is read. A last
 * segment `$` alone reads everything after it, as the router's `_splat`. */
interface AreaRoutePath {
  path: string;
  /** The route the address resolves to. Its fields are the path's parameters, by name. */
  route?: WorkspaceRoute["kind"];
  /** Where the address leads instead of resolving by itself. It may name the path's parameters. */
  redirectTo?: string;
}

/** One area of the interface and every address that opens it. */
interface AreaRoute {
  area: WorkspaceRouteView;
  paths: readonly AreaRoutePath[];
}

/** The name the router gives what a last `$` segment read. */
const SPLAT = "_splat";

/**
 * The address of one App as a pattern. It is built by the function the server answers
 * `interfacePath` with, so a link of the server and a route of the interface never disagree.
 */
function appPattern(mode: AppMode): string {
  return decodeURIComponent(
    appInterfacePath({ workspaceId: "$collaborationWorkspaceId", app: "$app", mode })
  );
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
      { path: "/c/$conversationId", route: "legacy-conversation" },
      // The list of every conversation was a page of its own for one release. The rail is
      // that list now, so its addresses lead to the start page of the workspace.
      {
        path: "/w/$collaborationWorkspaceId/conversations",
        redirectTo: "/w/$collaborationWorkspaceId"
      },
      { path: "/conversations", redirectTo: "/" }
    ]
  },
  {
    area: "agents",
    paths: [{ path: "/w/$collaborationWorkspaceId/agents", route: "agents" }]
  },
  {
    area: "apps",
    paths: [
      { path: "/w/$collaborationWorkspaceId/apps", route: "apps" },
      // The draft's address stands before the App's own routes: `edit` is never one of those.
      { path: appPattern("draft"), route: "app-edit" },
      { path: appPattern("published"), route: "app" },
      { path: `${appPattern("published")}/$`, route: "app" }
    ]
  },
  {
    area: "workflows",
    paths: [
      { path: "/w/$collaborationWorkspaceId/workflows", route: "workflows" },
      { path: "/w/$collaborationWorkspaceId/workflows/$workflow", route: "workflow" },
      { path: "/w/$collaborationWorkspaceId/workflows/$workflow/runs", route: "workflow-runs" },
      { path: "/w/$collaborationWorkspaceId/workflows/$workflow/runs/$run", route: "workflow-run" }
    ]
  },
  {
    area: "settings",
    paths: [
      { path: "/settings/$group/$page", route: "settings" },
      { path: "/settings", redirectTo: "/settings/you/profile" },
      { path: "/admin", route: "administration" },
      { path: "/admin/users", redirectTo: "/settings/instance/users" },
      { path: "/admin/usage", redirectTo: "/settings/instance/usage" },
      { path: "/admin/audit", redirectTo: "/settings/instance/audit" },
      { path: "/admin/api-access", redirectTo: "/settings/instance/api-access" }
    ]
  },
  {
    area: "inbox",
    paths: [
      { path: "/inbox", route: "inbox" },
      { path: "/inbox/$itemId", route: "inbox-item" },
      { path: "/approvals", redirectTo: "/inbox" }
    ]
  },
  {
    area: "build",
    paths: [
      { path: "/build", route: "build" },
      { path: "/build/$assetKind", route: "build-kind" },
      { path: "/build/$assetKind/$name", route: "build-asset" },
      { path: "/admin/config", redirectTo: "/build" }
    ]
  },
  {
    area: "ui-library",
    paths: [
      { path: "/ui-library", route: "ui-library" },
      { path: "/ui-library/workflows", route: "workflow-samples" }
    ]
  }
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

/**
 * The route a path opens. An address that leads elsewhere opens what it leads to, so a shell
 * without a router follows the table too. A path no row resolves opens the application root.
 */
export function workspaceRouteFromPath(pathname: string): WorkspaceRoute {
  const segments = pathSegments(normalizePathname(pathname));
  for (const { path, route, redirectTo } of areaRoutePaths()) {
    const params = matchPath(pathSegments(path), segments);
    if (params === undefined) {
      continue;
    }
    if (redirectTo !== undefined) {
      return workspaceRouteFromPath(pathWith(redirectTo, params));
    }
    const resolved = route === undefined ? undefined : routeOf(route, params);
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
  const splat = route.kind === "app" ? appSplat(route.appPath) : undefined;
  const to =
    areaRoutePaths().find(
      (candidate) =>
        candidate.route === route.kind && candidate.path.endsWith("/$") === (splat !== undefined)
    )?.path ?? "/";
  const { kind: _kind, ...fields } = route;
  const params: Record<string, string> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (name !== "appPath" && typeof value === "string") {
      params[name] = value;
    }
  }
  if (splat !== undefined) {
    params[SPLAT] = splat;
  }
  return Object.keys(params).length > 0 ? { to, params } : { to };
}

/** The path of a route, as a link's `href` takes it: the row's pattern with the route's fields. */
export function workspaceRoutePath(route: WorkspaceRoute): string {
  const { to, params = {} } = workspaceRouteNavigation(route);
  return pathWith(to, params);
}

/** A path pattern with its `$name` segments filled from `params`. */
function pathWith(pattern: string, params: Record<string, string>): string {
  return pattern
    .split("/")
    .map((part) =>
      part === "$"
        ? (params[SPLAT] ?? "").split("/").map(encodeURIComponent).join("/")
        : part.startsWith("$")
          ? encodeURIComponent(params[part.slice(1)] ?? "")
          : part
    )
    .join("/");
}

/**
 * The App's own route as the address carries it: without its first slash. Nothing for the
 * route an App starts on, and nothing for `/edit`, which the address of the draft has taken.
 */
function appSplat(appPath: string | undefined): string | undefined {
  const splat = appPath?.replace(/^\/+/u, "") ?? "";
  return splat === "" || splat === "edit" ? undefined : splat;
}

function routeOf(
  kind: WorkspaceRoute["kind"],
  params: Record<string, string>
): WorkspaceRoute | undefined {
  const { collaborationWorkspaceId, conversationId, group, page, itemId } = params;
  switch (kind) {
    case "collaboration-workspace-root":
    case "administration":
    case "build":
    case "inbox":
    case "ui-library":
    case "workflow-samples":
      return { kind };
    case "inbox-item":
      return itemId ? { kind, itemId } : undefined;
    case "settings":
      return group && page ? { kind, group, page } : undefined;
    case "build-kind":
      return params.assetKind ? { kind, assetKind: params.assetKind } : undefined;
    case "build-asset":
      return params.assetKind && params.name
        ? { kind, assetKind: params.assetKind, name: params.name }
        : undefined;
    case "new-conversation":
    case "agents":
    case "apps":
    case "workflows":
      return collaborationWorkspaceId ? { kind, collaborationWorkspaceId } : undefined;
    case "workflow":
    case "workflow-runs":
      return collaborationWorkspaceId && params.workflow
        ? { kind, collaborationWorkspaceId, workflow: params.workflow }
        : undefined;
    case "workflow-run":
      return collaborationWorkspaceId && params.workflow && params.run
        ? { kind, collaborationWorkspaceId, workflow: params.workflow, run: params.run }
        : undefined;
    case "app-edit":
      return collaborationWorkspaceId && params.app
        ? { kind, collaborationWorkspaceId, app: params.app }
        : undefined;
    case "app":
      return collaborationWorkspaceId && params.app
        ? {
            kind,
            collaborationWorkspaceId,
            app: params.app,
            ...(params[SPLAT] ? { appPath: `/${params[SPLAT]}` } : {})
          }
        : undefined;
    case "conversation":
      return collaborationWorkspaceId && conversationId
        ? { kind, collaborationWorkspaceId, conversationId }
        : undefined;
    case "legacy-conversation":
      return conversationId ? { kind, conversationId } : undefined;
  }
}

/** The parameters of `segments` under `pattern`, or nothing when they do not match. */
function matchPath(
  pattern: readonly string[],
  segments: readonly string[]
): Record<string, string> | undefined {
  const splat = pattern.at(-1) === "$";
  if (splat ? segments.length < pattern.length : pattern.length !== segments.length) {
    return undefined;
  }
  const params: Record<string, string> = {};
  for (const [index, part] of pattern.entries()) {
    const segment = segments[index];
    if (!segment) {
      return undefined;
    }
    if (part === "$") {
      params[SPLAT] = segments.slice(index).map(decodePathSegment).join("/");
    } else if (part.startsWith("$")) {
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
