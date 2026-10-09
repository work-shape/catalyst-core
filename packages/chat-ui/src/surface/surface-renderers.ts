import type { ReactNode } from "react";
import type { Surface, SurfaceKind, SurfaceOf } from "./surface";

/** What a renderer gives the frame: the content and the actions of its kind. */
interface SurfaceRendering {
  actions?: ReactNode;
  content: ReactNode;
}

/** One renderer per kind. A kind without one shows the frame with a sentence in place of content. */
export type SurfaceRenderers = {
  [Kind in SurfaceKind]?: (surface: SurfaceOf<Kind>) => SurfaceRendering;
};

function renderPrepared(surface: SurfaceOf<"tool_display" | "file_preview">): SurfaceRendering {
  return { actions: surface.headerActions, content: surface.node };
}

/** The renderers of the kinds that exist today. */
export const surfaceRenderers: SurfaceRenderers = {
  tool_display: renderPrepared,
  file_preview: renderPrepared
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
