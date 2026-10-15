import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { prefersReducedMotion } from "@work-shape/catalyst-ui";
import { useSplitArea } from "../surface/use-split-area";
import { readStoredSurfaceWidth, writeStoredSurfaceWidth } from "../../shared/workspace-utils";
import {
  clampDockWidth,
  DOCK_DEFAULT_WIDTH,
  DOCK_WIDTH_KEY,
  dockMotion,
  dockPlacement,
  type WorkspaceAddress
} from "../workspace/dock-state";
import type { DockArrival } from "./chat-dock";

/**
 * The dock's width in the main area `content`: 420 px until the person drags it, then what
 * they chose, kept in the browser. Dock and page each keep the split minimum; below twice
 * that the dock lies over the page.
 */
export function useDockWidth(content: HTMLElement | null) {
  const { mainWidth, splitMin } = useSplitArea(content, "self");
  const [chosen, setChosen] = useState<number | undefined>();
  const max = mainWidth === undefined ? Number.POSITIVE_INFINITY : mainWidth - splitMin;
  const stored = useMemo(
    () =>
      typeof window === "undefined"
        ? undefined
        : readStoredSurfaceWidth(DOCK_WIDTH_KEY, { min: splitMin, max }),
    [max, splitMin]
  );
  const keep = useCallback((width: number) => writeStoredSurfaceWidth(DOCK_WIDTH_KEY, width), []);
  return {
    over: dockPlacement(mainWidth, splitMin) === "over",
    width: clampDockWidth(chosen ?? stored ?? DOCK_DEFAULT_WIDTH, mainWidth, splitMin),
    min: splitMin,
    max: Math.max(splitMin, max),
    choose: setChosen,
    keep
  };
}

/** How long an arrival waits for the end of its animation before it ends anyway. */
const ARRIVAL_LIMIT_MS = 1000;

/**
 * The movement the shell plays itself when the conversation goes into the dock or out of it:
 * only where the host plays no view transition, and never under reduced motion. It ends when
 * its animation ends.
 */
export function useDockArrival(
  address: WorkspaceAddress,
  hostPlaysTransitions: boolean
): { arrival: DockArrival | undefined; arrived(): void } {
  const [arrival, setArrival] = useState<DockArrival | undefined>();
  const before = useRef(address);
  const { route, chat } = address;
  useLayoutEffect(() => {
    const motion = dockMotion(before.current, { route, chat });
    before.current = { route, chat };
    if (motion === undefined || hostPlaysTransitions || prefersReducedMotion()) {
      return;
    }
    setArrival(motion === "dock-in" ? "in" : "out");
  }, [chat, hostPlaysTransitions, route]);

  useEffect(() => {
    if (arrival === undefined) {
      return undefined;
    }
    const timer = window.setTimeout(() => setArrival(undefined), ARRIVAL_LIMIT_MS);
    return () => window.clearTimeout(timer);
  }, [arrival]);

  const arrived = useCallback(() => setArrival(undefined), []);
  return { arrival, arrived };
}
