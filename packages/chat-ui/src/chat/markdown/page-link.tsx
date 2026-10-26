import { TextLink } from "@work-shape/catalyst-ui";
import { createContext, useContext, type ReactNode } from "react";
import {
  workspaceRouteFromPath,
  workspaceRoutePath,
  type WorkspaceRoute
} from "../../shared/routes";
import { routeLink } from "../../studio/workflows/workflows-frame";

// A link in a reply to a page of this app, such as a Data Store's page, opens that page in
// place with the conversation docked beside it (CHAT-LINK-1). Every other link stays as the
// link policy leaves it.

/** The element a link to a page of the app becomes, so the reply renders it as `PageLink`. */
export const PAGE_LINK_TAG = "catalyst-page-link";

/** Routes an address resolves to before the app knows where it leads: they are no page. */
const UNRESOLVED_ROUTES = new Set<WorkspaceRoute["kind"]>([
  "not-found",
  "collaboration-workspace-root",
  "legacy-conversation",
  "administration"
]);

/**
 * The page a link opens in place: the route of an address on the page's own origin that the
 * route table knows. Nothing for another origin, another protocol or a path no route reads.
 */
export function pageLinkRoute(href: string, pageOrigin: string): WorkspaceRoute | undefined {
  let url: URL;
  try {
    url = new URL(href, pageOrigin);
  } catch {
    return undefined;
  }
  if (url.origin !== pageOrigin) return undefined;
  const route = workspaceRouteFromPath(url.pathname);
  return UNRESOLVED_ROUTES.has(route.kind) ? undefined : route;
}

/**
 * The address a link to a page of the app carries: the page's own path. A query or a fragment
 * the model wrote is left out, so a copied link holds no conversation and no token.
 */
export function pageLinkPath(href: string, pageOrigin: string): string | undefined {
  const route = pageLinkRoute(href, pageOrigin);
  return route === undefined ? undefined : workspaceRoutePath(route);
}

/** What opens a page in place: the conversation's own way to a page with it docked. */
export interface PageLinks {
  open(page: WorkspaceRoute): void;
}

const PageLinksContext = createContext<PageLinks | undefined>(undefined);

/**
 * Lets links in the replies below open pages of the app in place. Without it, as in a mail
 * preview, such a link behaves as every other link does.
 */
export const PageLinksProvider = PageLinksContext.Provider;

export function usePageLinks(): PageLinks | undefined {
  return useContext(PageLinksContext);
}

/**
 * A link to a page of the app. A plain click opens it in place; a click with a modifier key,
 * the middle button or the browser's own "Open in new tab" opens its address alone.
 */
export function PageLink({ href, children }: { href?: string; children?: ReactNode }) {
  const links = usePageLinks();
  const route = href === undefined ? undefined : workspaceRouteFromPath(href);
  const link = links && route ? routeLink(route, links.open) : { href };
  return (
    <TextLink
      {...link}
      className="wrap-anywhere font-medium underline"
      data-streamdown="link"
      data-page-link=""
    >
      {children}
    </TextLink>
  );
}
