import { createElement, type ReactNode } from "react";
import { AppPreview } from "../apps/app-preview";
import { InboxItemPanel } from "../inbox/inbox-item-panel";
import { pageSurfaceRendering } from "../pages/page-surface";
import type { Surface, SurfaceKind, SurfaceOf } from "./surface";

/** What a renderer gives the frame: the content and the actions of its kind. */
interface SurfaceRendering {
  actions?: ReactNode;
  /** An icon of what the surface shows. The frame draws it before the title. */
  titleIcon?: ReactNode;
  content: ReactNode;
  /** The content reaches the edges of the frame and lays out its own height. */
  flush?: boolean;
}

/** One renderer per kind. A kind without one shows the frame with a sentence in place of content. */
export type SurfaceRenderers = {
  [Kind in SurfaceKind]?: (surface: SurfaceOf<Kind>) => SurfaceRendering;
};

function renderPrepared(surface: SurfaceOf<"tool_display" | "file_preview">): SurfaceRendering {
  return { actions: surface.headerActions, titleIcon: surface.titleIcon, content: surface.node };
}

/** The renderers of the kinds that exist today. */
export const surfaceRenderers: SurfaceRenderers = {
  tool_display: renderPrepared,
  file_preview: renderPrepared,
  inbox_item: (surface) => ({ content: createElement(InboxItemPanel, { itemId: surface.itemId }) }),
  page: pageSurfaceRendering,
  // An App fills the frame like a Page. The address stays the area's that shows the slot, so
  // the App's own moves are not written into it.
  app_view: (surface) => ({
    content: createElement(AppPreview, {
      key: surface.key,
      app: surface.app,
      mode: "published",
      name: surface.title,
      appPath: surface.appPath
    }),
    flush: true
  }),
  app_edit: (surface) => ({
    content: createElement(AppPreview, {
      key: surface.key,
      app: surface.app,
      mode: "draft",
      name: surface.title
    }),
    flush: true
  })
};

/** The rendering of a surface, or nothing when its kind has no renderer. */
export function renderSurface(
  renderers: SurfaceRenderers,
  surface: Surface
): SurfaceRendering | undefined {
  return renderOf(renderers, surface);
}

function renderOf<Kind extends SurfaceKind>(
  renderers: SurfaceRenderers,
  surface: SurfaceOf<Kind>
): SurfaceRendering | undefined {
  const renderer: ((surface: SurfaceOf<Kind>) => SurfaceRendering) | undefined =
    renderers[surface.kind];
  return renderer?.(surface);
}
