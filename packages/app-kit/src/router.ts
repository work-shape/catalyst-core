import {
  createMemoryHistory,
  createRouter,
  type AnyRoute,
  type AnyRouter
} from "@tanstack/react-router";

/**
 * The router of a Page in a frame. Its history is kept in memory: the frame has no address of
 * its own to change, and a link in a Page has none either. Every route the Page arrives at is
 * told to `onNavigate`, which is how the interface learns where the Page is.
 */
export function createAppRouter(input: {
  routeTree: AnyRoute;
  /** The route the Page starts on. */
  initialRoute?: string;
  onNavigate?: (path: string) => void;
}): AnyRouter {
  const router = createRouter({
    routeTree: input.routeTree,
    history: createMemoryHistory({ initialEntries: [input.initialRoute ?? "/"] })
  });
  const { onNavigate } = input;
  if (onNavigate) {
    router.subscribe("onResolved", (event) => onNavigate(event.toLocation.href));
  }
  return router;
}
