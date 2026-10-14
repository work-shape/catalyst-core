import { useEffect, useState, type AnimationEvent } from "react";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Whether the person asked their system for less motion. Nothing moves then. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(REDUCED_MOTION_QUERY).matches
  );
}

/** A time token in milliseconds, as it applies where `element` stands. */
function durationToken(style: CSSStyleDeclaration, token: string): number {
  const value = style.getPropertyValue(token).trim();
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount)) {
    return 0;
  }
  return value.endsWith("ms") ? amount : amount * 1000;
}

/** How far `element` is moved sideways right now by a move that is still under way. */
function movedBy(element: HTMLElement): number {
  const transform = getComputedStyle(element).transform;
  return transform === "none" || typeof DOMMatrixReadOnly === "undefined"
    ? 0
    : new DOMMatrixReadOnly(transform).m41;
}

/** The moves `moveFrom` started on an element, so a new one replaces the one under way. */
const moves = new WeakMap<HTMLElement, Animation>();

/**
 * Where `element` is laid out, from the left edge of the window: without the offset of a move
 * that is still under way.
 */
export function restingLeft(element: HTMLElement): number {
  return element.getBoundingClientRect().left - movedBy(element);
}

/**
 * Lets an element that was just laid out at a new place travel there from where it was seen
 * last, instead of jumping: `previousLeft` is its `restingLeft` before the layout changed. The
 * move takes as long as a panel takes to open or to close and has the same curve, so both read
 * as one movement. Only its place moves; its width has changed once, at the start. Nothing
 * moves under reduced motion.
 */
export function moveFrom(
  element: HTMLElement,
  previousLeft: number,
  phase: "open" | "close" = "open"
): void {
  // Where it is seen now: its last place, and what was left of an earlier move.
  const seenLeft = previousLeft + movedBy(element);
  moves.get(element)?.cancel();
  moves.delete(element);
  const offset = seenLeft - element.getBoundingClientRect().left;
  if (Math.abs(offset) < 1 || typeof element.animate !== "function" || prefersReducedMotion()) {
    return;
  }
  const style = getComputedStyle(element);
  const move = element.animate([{ transform: `translateX(${offset}px)` }, { transform: "none" }], {
    duration: durationToken(style, phase === "open" ? "--duration-open" : "--duration-close"),
    easing: style.getPropertyValue("--ease-move").trim() || "ease-out"
  });
  moves.set(element, move);
}

/** How long a held part waits for the end of its way out before it leaves anyway. */
const EXIT_LIMIT_MS = 1000;

/**
 * Keeps what was shown for as long as its way out takes. `held` is what to render: the value
 * that is shown, or the last one while it leaves. The element that plays the way out, such as
 * `animate-panel-out`, reports its end through `onAnimationEnd`. Under reduced motion nothing
 * is held: what closes is gone at once. Pass the same value for as long as the same thing is
 * shown; a new one each render never rests.
 */
export function useExit<Shown>(shown: Shown | undefined): {
  held: Shown | undefined;
  leaving: boolean;
  onAnimationEnd(event: AnimationEvent<HTMLElement>): void;
} {
  const [last, setLast] = useState(shown);
  const [leaving, setLeaving] = useState(false);

  // State derived from the render before: what is shown now replaces what was held.
  if (shown !== undefined) {
    if (!Object.is(last, shown)) {
      setLast(shown);
    }
    if (leaving) {
      setLeaving(false);
    }
  } else if (last !== undefined && !leaving) {
    if (prefersReducedMotion()) {
      setLast(undefined);
    } else {
      setLeaving(true);
    }
  }

  // A way out that never reports its end, as in a window that is not painted, still ends.
  useEffect(() => {
    if (!leaving) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setLeaving(false);
      setLast(undefined);
    }, EXIT_LIMIT_MS);
    return () => window.clearTimeout(timer);
  }, [leaving]);

  return {
    held: shown ?? (leaving ? last : undefined),
    leaving: shown === undefined && leaving,
    onAnimationEnd(event) {
      // The end of a part's own animation inside the panel is not the end of the panel's.
      if (event.target !== event.currentTarget || shown !== undefined) {
        return;
      }
      setLeaving(false);
      setLast(undefined);
    }
  };
}
