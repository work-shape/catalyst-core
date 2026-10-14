import type { SurfaceKind } from "./surface";

/**
 * The width a surface opens at until its width has been changed: a share of the main area up
 * to `max` pixels, or `max` pixels where the kind names no share. The split minimum of both
 * sides still applies.
 */
interface SurfaceDefaultWidth {
  share?: number;
  max: number;
}

/** A kind without a line of its own opens at this width; the slice that renders it sets its own. */
const DEFAULT_SURFACE_WIDTH = 560;
const surfaceDefaultWidths: Partial<Record<SurfaceKind, SurfaceDefaultWidth>> = {
  // A file or a view is read beside the conversation: it takes a little less than half of the
  // main area, so the conversation stays the wider side, and no more than a page needs.
  tool_display: { share: 0.45, max: 720 },
  file_preview: { share: 0.45, max: 720 },
  // An item is read like a document: wide enough for a proposal's lines beside the list.
  inbox_item: { max: 520 },
  // A Page is laid out like a small application: it gets more room than a document.
  page: { max: 640 },
  // The place a Page's preview takes once it is built.
  page_building: { max: 640 },
  // What the agent of the conversation changes is the larger side: a Workflow is a graph to
  // read across, an App an application of its own. An agent reads like a document.
  workflow_canvas: { share: 0.6, max: 1100 },
  app_edit: { share: 0.55, max: 960 },
  agent: { max: 560 }
};

/** The width `kind` opens at in a main area of `mainWidth`, before the split minimum applies. */
export function defaultSurfaceWidth(
  kind: SurfaceKind | undefined,
  mainWidth: number | undefined
): number {
  const preset = kind === undefined ? undefined : surfaceDefaultWidths[kind];
  if (!preset) {
    return DEFAULT_SURFACE_WIDTH;
  }
  return preset.share === undefined || mainWidth === undefined
    ? preset.max
    : Math.min(preset.max, Math.round(mainWidth * preset.share));
}

/**
 * `--layout-split-min` in pixels at the default root font size. It is used only where the
 * token cannot be measured: on the server and before the slot is in the document.
 */
export const SPLIT_MIN_FALLBACK_PX = 380;

/**
 * Where what opens at the right of the conversation stands: `beside` it, or `covering` it
 * because both sides would not keep their minimum. One rule for the surface and for the
 * Resources card: from twice the split minimum of main area they stand beside the
 * conversation, below it they lie over it. Nothing else gives way: the sidebar is collapsed by
 * its reader alone, and the conversation is never narrower than the split minimum.
 */
type SurfacePlacement = "beside" | "covering";

export function surfacePlacement(
  mainWidth: number | undefined,
  splitMin: number
): SurfacePlacement {
  return mainWidth !== undefined && mainWidth < splitMin * 2 ? "covering" : "beside";
}

/** The widest a surface may be beside the conversation, so the conversation keeps its minimum. */
export function maxSurfaceWidth(mainWidth: number | undefined, splitMin: number): number {
  return mainWidth === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(splitMin, mainWidth - splitMin);
}

/** A width for the surface that leaves both sides their minimum. */
export function clampSurfaceWidth(
  width: number,
  mainWidth: number | undefined,
  splitMin: number
): number {
  return Math.round(Math.min(Math.max(width, splitMin), maxSurfaceWidth(mainWidth, splitMin)));
}

/** The token `--layout-split-min` in pixels, measured where `element` stands. */
export function measureSplitMin(element: Element): number {
  const value = getComputedStyle(element).getPropertyValue("--layout-split-min").trim();
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    return SPLIT_MIN_FALLBACK_PX;
  }
  if (value.endsWith("rem")) {
    const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    return Number.isFinite(rootFontSize) && rootFontSize > 0
      ? amount * rootFontSize
      : SPLIT_MIN_FALLBACK_PX;
  }
  return value.endsWith("px") ? amount : SPLIT_MIN_FALLBACK_PX;
}
