import { useState, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "../cn";

/** How far one arrow key moves the split, in pixels. */
const SPLIT_KEY_STEP = 16;

export interface SplitHandleProps {
  /** Names the handle for a screen reader, such as "Resize chat". */
  label: string;
  /** The edge of the panel the handle stands on: the panel lies on the other side of it. */
  edge: "left" | "right";
  /** The panel's width in pixels. */
  width: number;
  /** The least and the greatest width the panel may take. */
  min: number;
  max: number;
  /**
   * What the separator says it stands at, where that is not the panel's width: the width of
   * the side before it, as a panel at the right reports the conversation's.
   */
  value?: { now: number; min: number; max: number };
  /** Told each width the handle chooses, already held between `min` and `max`. */
  onResize(width: number): void;
  /** Told the width a drag or a key ended on, for keeping it. */
  onResizeEnd?(width: number): void;
}

function clampWidth(width: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(width, min), Math.max(min, max)));
}

/**
 * The hairline between a panel and what stands beside it, which the pointer drags and the
 * arrow keys move. It is 12 px wide to the pointer and takes the ring colour only while it is
 * dragged or holds the keyboard focus. Left and Home move it left, right and End move it right,
 * whichever side the panel stands on.
 */
export function SplitHandle({
  label,
  edge,
  width,
  min,
  max,
  value,
  onResize,
  onResizeEnd
}: SplitHandleProps) {
  const [resizing, setResizing] = useState(false);
  // Moving the handle by `distance` pixels to the right changes the panel's width by this much.
  const grow = (distance: number) => (edge === "right" ? distance : -distance);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const target = event.currentTarget;
    let latest: number | undefined;
    target.setPointerCapture(event.pointerId);
    setResizing(true);

    function onPointerMove(moveEvent: globalThis.PointerEvent) {
      latest = clampWidth(startWidth + grow(moveEvent.clientX - startX), min, max);
      onResize(latest);
    }

    function onPointerUp(upEvent: globalThis.PointerEvent) {
      if (target.hasPointerCapture(upEvent.pointerId)) {
        target.releasePointerCapture(upEvent.pointerId);
      }
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      setResizing(false);
      if (latest !== undefined) {
        onResizeEnd?.(latest);
      }
    }

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const leftmost = edge === "right" ? min : max;
    const rightmost = edge === "right" ? max : min;
    const next =
      event.key === "ArrowLeft"
        ? width + grow(-SPLIT_KEY_STEP)
        : event.key === "ArrowRight"
          ? width + grow(SPLIT_KEY_STEP)
          : event.key === "Home"
            ? leftmost
            : event.key === "End"
              ? rightmost
              : undefined;
    if (next === undefined) {
      return;
    }
    event.preventDefault();
    const chosen = clampWidth(next, min, max);
    onResize(chosen);
    onResizeEnd?.(chosen);
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={Math.round(value?.min ?? min)}
      aria-valuemax={Math.round(value?.max ?? max)}
      aria-valuenow={Math.round(value?.now ?? width)}
      tabIndex={0}
      data-resizing={resizing ? "" : undefined}
      className={cn(
        "absolute inset-y-0 z-10 w-3 cursor-col-resize touch-none outline-none",
        edge === "left" ? "left-0 -translate-x-1/2" : "right-0 translate-x-1/2",
        "after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2",
        "focus-visible:after:bg-ring data-resizing:after:bg-ring"
      )}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
    />
  );
}
