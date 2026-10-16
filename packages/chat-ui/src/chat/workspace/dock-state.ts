import {
  isChatWorkspaceRoute,
  routeConversationId,
  type DockMotion,
  type WorkspaceRoute
} from "../../shared/workspace-route";

/**
 * The chat dock: one conversation panel of the shell that stands at the left of every page
 * except the chat route, and survives every change of route. Its conversation rides in the
 * address as `?chat=<conversation>`; the chat route names its conversation in its path, so it
 * has no dock.
 */

/** The name of the address's search parameter that carries the dock's conversation. */
export const DOCK_SEARCH_PARAM = "chat";

/** Where the person is: the route and the conversation of the dock beside it. */
export interface WorkspaceAddress {
  route: WorkspaceRoute;
  chat?: string;
}

/** The conversation the dock of an address holds. The chat route has no dock. */
export function addressDockConversation(address: WorkspaceAddress): string | undefined {
  return isChatWorkspaceRoute(address.route) ? undefined : address.chat || undefined;
}

/** The movement from one address to the next, where one conversation goes into or out of the dock. */
export function dockMotion(from: WorkspaceAddress, to: WorkspaceAddress): DockMotion | undefined {
  const fromChat = routeConversationId(from.route);
  if (fromChat !== undefined && addressDockConversation(to) === fromChat) {
    return "dock-in";
  }
  const fromDock = addressDockConversation(from);
  return fromDock !== undefined && routeConversationId(to.route) === fromDock
    ? "dock-out"
    : undefined;
}

/** The conversation the address `?chat=` names, from the search string of a location. */
export function dockConversationOfSearch(
  search: Readonly<Record<string, unknown>>
): string | undefined {
  const value = search[DOCK_SEARCH_PARAM];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * The search of the next address: the dock's conversation, and, on the same page, the other
 * parameters the page keeps in it.
 */
export function searchWithDock(
  previous: Readonly<Record<string, unknown>> | undefined,
  chat: string | undefined
): Record<string, unknown> {
  const { [DOCK_SEARCH_PARAM]: _dropped, ...kept } = previous ?? {};
  return chat === undefined ? kept : { ...kept, [DOCK_SEARCH_PARAM]: chat };
}

/** The width the dock opens at, in pixels, until the person drags it. */
export const DOCK_DEFAULT_WIDTH = 420;

/** The key the dock's dragged width is kept under, beside the widths of the surface kinds. */
export const DOCK_WIDTH_KEY = "dock";

/**
 * How the dock stands in a main area of `mainWidth`: `beside` the page while both keep the
 * split minimum, `over` it at full width below that.
 */
export function dockPlacement(mainWidth: number | undefined, splitMin: number): "beside" | "over" {
  return mainWidth !== undefined && mainWidth < splitMin * 2 ? "over" : "beside";
}

/** A width for the dock that leaves it and the page their minimum. */
export function clampDockWidth(width: number, mainWidth: number | undefined, splitMin: number) {
  const max = mainWidth === undefined ? Number.POSITIVE_INFINITY : mainWidth - splitMin;
  return Math.round(Math.min(Math.max(width, splitMin), Math.max(splitMin, max)));
}
