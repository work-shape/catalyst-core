import type { SurfaceKind } from "./surface";

/**
 * The width a surface opens at until its width has been changed, in pixels. A kind without a
 * line of its own opens at `DEFAULT_SURFACE_WIDTH`; the slice that renders it sets its own.
 */
export const DEFAULT_SURFACE_WIDTH = 560;
export const surfaceDefaultWidths: Partial<Record<SurfaceKind, number>> = {
  tool_display: DEFAULT_SURFACE_WIDTH,
  file_preview: DEFAULT_SURFACE_WIDTH
};

/**
 * `--layout-split-min` in pixels at the default root font size. It is used only where the
 * token cannot be measured: on the server and before the slot is in the document.
 */
export const SPLIT_MIN_FALLBACK_PX = 380;

/** `beside` the conversation, or `covering` the main area because both sides would not fit. */
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
