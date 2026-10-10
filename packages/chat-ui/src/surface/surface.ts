import type { ReactNode } from "react";

/** What an already rendered surface carries: its content and the actions of its header. */
interface RenderedSurfaceSource {
  node: ReactNode;
  headerActions?: ReactNode;
}

/**
 * Every kind of surface the slot can hold, with the source fields of each. The kinds without a
 * renderer carry none yet: the slice that renders a kind adds its fields here and its renderer
 * to the renderer record. It adds no kind.
 */
interface SurfaceSources {
  tool_display: RenderedSurfaceSource;
  file_preview: RenderedSurfaceSource;
  page: unknown;
  app_view: unknown;
  app_edit: unknown;
  workflow_canvas: unknown;
  /** One item of the Inbox, by its id. The renderer reads the item's live state itself. */
  inbox_item: { itemId: string };
}

export type SurfaceKind = keyof SurfaceSources;

/** One member of the surface union. */
export type SurfaceOf<Kind extends SurfaceKind> = {
  kind: Kind;
  /** Identifies the surface: the card that produced it compares this to know it is shown. */
  key: string;
  title: string;
  subtitle?: string;
} & SurfaceSources[Kind];

/** What the surface slot holds: one surface at a time, told apart by `kind`. */
export type Surface = { [Kind in SurfaceKind]: SurfaceOf<Kind> }[SurfaceKind];
