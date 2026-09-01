import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject
} from "react";

/**
 * Scroll-edge affordance shared by the scrollable panels.
 *
 * A scroll container that slices its content off flat at the edge reads as a
 * broken layout: nothing tells you whether more content is hidden or the list
 * simply ends. Fading the content out over the last few pixels of an edge that
 * actually has hidden content answers that, and only on the edges that need it.
 *
 * This is the mask the attachment list in the composer already uses, lifted so
 * every panel signals overflow the same way. A mask fades the content to
 * transparent rather than painting a colour over it, so it needs no knowledge
 * of the surface behind it and works unchanged in light and dark themes.
 */
const SCROLL_EDGE_FADE_HEIGHT = "1rem";

export interface ScrollEdgeOverflow {
  /** Content is hidden above the top edge. */
  above: boolean;
  /** Content is hidden below the bottom edge. */
  below: boolean;
}

export function scrollEdgeFadeMask(overflow: ScrollEdgeOverflow): string | undefined {
  if (!overflow.above && !overflow.below) {
    return undefined;
  }
  const stops = [
    overflow.above ? `transparent 0, #000 ${SCROLL_EDGE_FADE_HEIGHT}` : "#000 0",
    overflow.below ? `#000 calc(100% - ${SCROLL_EDGE_FADE_HEIGHT}), transparent 100%` : "#000 100%"
  ];
  return `linear-gradient(to bottom, ${stops.join(", ")})`;
}

/**
 * Wire a scroll container to the fade. Spread `ref`, `onScroll` and `style`
 * onto the scrolling element; pass anything that changes its content length in
 * `dependencies` so the edges are re-measured when rows appear or disappear.
 */
export function useScrollEdgeFade<Element extends HTMLElement>(
  dependencies: readonly unknown[] = []
): {
  ref: RefObject<Element | null>;
  overflow: ScrollEdgeOverflow;
  onScroll(): void;
  style: CSSProperties | undefined;
} {
  const ref = useRef<Element>(null);
  const [overflow, setOverflow] = useState<ScrollEdgeOverflow>({ above: false, below: false });

  const syncOverflow = useCallback(() => {
    const node = ref.current;
    if (!node) {
      return;
    }
    // The 1px slack absorbs fractional scroll offsets on scaled displays.
    const above = node.scrollTop > 1;
    const below = node.scrollTop + node.clientHeight < node.scrollHeight - 1;
    setOverflow((previous) =>
      previous.above === above && previous.below === below ? previous : { above, below }
    );
  }, []);

  /*
   * useEffect rather than useLayoutEffect: these panels are server-rendered in
   * the SSR tests, where a layout effect warns and does nothing anyway. The
   * cost is that the fade appears one frame after the panel does.
   */
  useEffect(() => {
    syncOverflow();
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(syncOverflow);
    observer.observe(node);
    // Content taller than the container changes the scroll height without
    // resizing the container itself, so watch the content box too.
    const content = node.firstElementChild;
    if (content) {
      observer.observe(content);
    }
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncOverflow, ...dependencies]);

  const mask = scrollEdgeFadeMask(overflow);

  return {
    ref,
    overflow,
    onScroll: syncOverflow,
    style: mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined
  };
}
