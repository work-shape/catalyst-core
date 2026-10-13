import { useLayoutEffect, useRef, type RefObject } from "react";
import { moveFrom, restingLeft } from "@vivd-catalyst/ui";

/**
 * A panel at the right of the conversation, the surface or the Resources card, changes the
 * room the conversation has when it opens or closes. The conversation takes its new width at
 * once, so its text wraps one time, and travels to its new place while the panel comes in or
 * leaves. The panel says that it moves; what stands beside it asks, in the same frame, whether
 * the change of its room is such a move. A window that is resized, a sidebar that collapses
 * and a split that is dragged announce nothing, so the conversation follows them at once.
 */
type PanelMove = "open" | "close";

/** How long an announcement holds: the layout it changes is measured in the same frame. */
const ANNOUNCED_FOR_MS = 50;

let announced: { move: PanelMove; until: number } | undefined;

/** Called by a panel in the layout effect of the render that opens, closes or exchanges it. */
export function announcePanelMove(move: PanelMove): void {
  announced = { move, until: performance.now() + ANNOUNCED_FOR_MS };
}

function announcedPanelMove(): PanelMove | undefined {
  return announced && performance.now() <= announced.until ? announced.move : undefined;
}

/**
 * For the column that holds the conversation's text. When a panel beside it opens or closes,
 * the column moves to its new place instead of jumping there.
 */
export function useMoveWithPanels<Column extends HTMLElement>(): RefObject<Column | null> {
  const columnRef = useRef<Column>(null);

  useLayoutEffect(() => {
    const column = columnRef.current;
    const room = column?.parentElement;
    if (!column || !room || typeof ResizeObserver === "undefined") {
      return undefined;
    }
    let left = restingLeft(column);
    // The room is observed, not the column: a column at its widest keeps its width and only
    // changes its place when the room does.
    const observer = new ResizeObserver(() => {
      const move = announcedPanelMove();
      if (move) {
        moveFrom(column, left, move);
      }
      left = restingLeft(column);
    });
    observer.observe(room);
    return () => observer.disconnect();
  }, []);

  return columnRef;
}
