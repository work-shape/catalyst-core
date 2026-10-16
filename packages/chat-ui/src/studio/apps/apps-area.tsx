import type { WorkspaceRoute } from "../../shared/workspace-route";
import { AppEdit } from "./app-edit";
import { AppView } from "./app-view";
import { AppsPage } from "./apps-page";

/** The routes of the Apps area. */
export type AppsRoute = Extract<WorkspaceRoute, { kind: "apps" | "app" | "app-edit" }>;

export function isAppsRoute(route: WorkspaceRoute): route is AppsRoute {
  return route.kind === "apps" || route.kind === "app" || route.kind === "app-edit";
}

/**
 * The Apps area: the list of the workspace's Apps, one App across the full width, or the
 * draft of one. Each is a page with an address of its own.
 */
export function AppsArea({ route }: { route: AppsRoute }) {
  switch (route.kind) {
    case "apps":
      return <AppsPage />;
    case "app":
      // Another App is another frame and another record.
      return <AppView key={route.app} app={route.app} appPath={route.appPath} />;
    case "app-edit":
      return <AppEdit key={route.app} app={route.app} />;
  }
}
