import { useLayoutEffect, useState } from "react";
import { measureSplitMin, SPLIT_MIN_FALLBACK_PX } from "./surface-layout";

/** The main area a split shares, as measured: its width and the minimum each side keeps. */
interface SplitArea {
  /** Undefined until the area is in the document. */
  mainWidth: number | undefined;
  splitMin: number;
}

/**
 * Measures the main area: `anchor` itself, or the element it stands in. `anchor` is held in
 * state by its owner, so the measure starts when the element is there, and the first one is
 * taken before that frame is painted.
 */
export function useSplitArea(anchor: HTMLElement | null, area: "self" | "parent"): SplitArea {
  const [measured, setMeasured] = useState<SplitArea>({
    mainWidth: undefined,
    splitMin: SPLIT_MIN_FALLBACK_PX
  });

  useLayoutEffect(() => {
    const main = area === "self" ? anchor : anchor?.parentElement;
    if (!anchor || !main) {
      return undefined;
    }
    const measure = () => {
      const mainWidth = main.getBoundingClientRect().width;
      const splitMin = measureSplitMin(anchor);
      setMeasured((current) =>
        current.mainWidth === mainWidth && current.splitMin === splitMin
          ? current
          : { mainWidth, splitMin }
      );
    };
    measure();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    // Measured a frame later: a width set while the browser still delivers resizes changes
    // what other observers watch, which it reports as a resize observer loop.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(measure);
    });
    observer.observe(main);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [anchor, area]);

  return measured;
}
