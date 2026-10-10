import { createContext, useContext } from "react";

/** Whether the navigation around an item shows icons only. `Sidebar` sets it. */
export const NavCollapsedContext = createContext(false);

/** True inside a `Sidebar` that is collapsed to icons, for what its header and footer show. */
export function useSidebarCollapsed(): boolean {
  return useContext(NavCollapsedContext);
}

/**
 * Whether a group's label stays in view while its items scroll under it. The scrolling body of
 * a `Sidebar` sets it.
 */
export const NavGroupLabelPinnedContext = createContext(false);
