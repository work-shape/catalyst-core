import { createContext, useContext } from "react";
import type { WorkspaceRoute } from "../routes";

/** Where the reader is inside the Build area: a kind's list, or one asset of it. */
export interface BuildLocation {
  /** The kind's path segment. Absent at `/build`. */
  kindPath?: string;
  /** The asset's id. Absent on a list. */
  name?: string;
}

/** The place in Build a route names, or nothing for a route of another area. */
export function buildLocationOfRoute(route: WorkspaceRoute): BuildLocation | undefined {
  switch (route.kind) {
    case "build":
      return {};
    case "build-kind":
      return { kindPath: route.assetKind };
    case "build-asset":
      return { kindPath: route.assetKind, name: route.name };
    default:
      return undefined;
  }
}

/** The route of a place in Build. */
export function buildRouteOfLocation(location: BuildLocation): WorkspaceRoute {
  if (location.kindPath === undefined) {
    return { kind: "build" };
  }
  return location.name === undefined
    ? { kind: "build-kind", assetKind: location.kindPath }
    : { kind: "build-asset", assetKind: location.kindPath, name: location.name };
}

/** The open place in Build and the way to another one. */
export interface BuildNavigation {
  location: BuildLocation;
  /** Opens a place. `replace` corrects the address without a step in the history. */
  open(location: BuildLocation, options?: { replace?: boolean }): void;
}

const BuildNavigationContext = createContext<BuildNavigation | undefined>(undefined);

export const BuildNavigationProvider = BuildNavigationContext.Provider;

export function useBuildNavigation(): BuildNavigation {
  const value = useContext(BuildNavigationContext);
  if (!value) {
    throw new Error("useBuildNavigation must be used within a BuildNavigationProvider");
  }
  return value;
}
