import { useEffect, type RefObject } from "react";

/** The pinned head of the `Page` that `from` stands in. */
export function pageHead(from: Element): HTMLElement | null {
  return from.closest("[data-page]")?.querySelector<HTMLElement>("[data-page-head]") ?? null;
}

/**
 * How much of the top of the scroll area stays covered while the `Page` that `from` stands in
 * scrolls: its pinned head and the `PageBar`s under it, as tall as they are on this screen. A
 * section scrolled to rests below them.
 */
export function pagePinnedHeight(from: Element): number {
  const page = from.closest("[data-page]");
  if (!page) {
    return 0;
  }
  return [...page.querySelectorAll("[data-page-head], [data-page-bar]")].reduce(
    (height, pinned) => height + pinned.getBoundingClientRect().height,
    0
  );
}

/**
 * Sets `property` on the element to the height of its page's pinned head, and keeps it there
 * as the head grows or shrinks: a head of two lines on a phone is taller than the token.
 */
export function usePageHeadHeight(ref: RefObject<HTMLElement | null>, property: string): void {
  useEffect(() => {
    const element = ref.current;
    const head = element ? pageHead(element) : null;
    if (!element || !head) {
      return undefined;
    }
    const apply = () => {
      element.style.setProperty(property, `${head.getBoundingClientRect().height}px`);
    };
    apply();
    const resized = new ResizeObserver(apply);
    resized.observe(head);
    return () => {
      resized.disconnect();
      element.style.removeProperty(property);
    };
  }, [ref, property]);
}
