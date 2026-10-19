import { useLayoutEffect, type RefObject } from "react";

/**
 * Where to scroll so the reader keeps their place after the thread's text has wrapped anew:
 * the end of the thread for a reader who was at the end, otherwise the position that puts the
 * block they were reading back where it stood. `blockTop` is the distance of that block from
 * the upper edge of the viewport, before and after.
 */
export function scrollTopKeepingPlace(input: {
  scrollTop: number;
  maxScrollTop: number;
  atEnd: boolean;
  blockTop: { before: number; now: number } | undefined;
}): number {
  if (input.atEnd) {
    return input.maxScrollTop;
  }
  if (!input.blockTop) {
    return input.scrollTop;
  }
  const kept = input.scrollTop + input.blockTop.now - input.blockTop.before;
  return Math.min(Math.max(kept, 0), input.maxScrollTop);
}

/** The parts of a message that keep their first line when the text wraps anew. */
const BLOCKS = "p, li, pre, tr, h1, h2, h3, h4, h5, h6, blockquote, figure";

/** How far under the upper edge of the viewport reading starts: below the floating header. */
const READING_LINES = [96, 144, 192, 288];

/**
 * Keeps the reader's place in the thread when its column changes width, as it does when a
 * panel opens or closes beside it. The text wraps anew, so the same scroll position would show
 * other lines: the block under the header is put back where it stood, and a reader at the end
 * stays at the end. `columnRef` is the column that holds the messages; it scrolls in the
 * element it stands in.
 */
export function useKeepReadingPlace(columnRef: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const column = columnRef.current;
    const viewport = column?.parentElement;
    if (!column || !viewport || typeof ResizeObserver === "undefined") {
      return undefined;
    }
    let place: { block: Element | undefined; top: number; atEnd: boolean } = {
      block: undefined,
      top: 0,
      atEnd: true
    };
    const maxScrollTop = () => viewport.scrollHeight - viewport.clientHeight;
    const topOf = (block: Element) =>
      block.getBoundingClientRect().top - viewport.getBoundingClientRect().top;

    const note = () => {
      const atEnd = maxScrollTop() - viewport.scrollTop <= 1;
      const box = viewport.getBoundingClientRect();
      const columnBox = column.getBoundingClientRect();
      const x = columnBox.left + columnBox.width / 2;
      for (const line of READING_LINES) {
        const hit = document.elementFromPoint(x, box.top + line);
        // Something that lies over the thread, such as a dialog, is not what was being read.
        if (!hit || hit === column || !column.contains(hit)) {
          continue;
        }
        const block = hit.closest(BLOCKS) ?? hit;
        place = { block: column.contains(block) ? block : hit, top: topOf(block), atEnd };
        return;
      }
      place = { block: undefined, top: 0, atEnd };
    };

    let frame = 0;
    const noteSoon = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(note);
    };

    let width = column.offsetWidth;
    // The column also changes its height with every word of an answer; only a new width
    // wraps the text anew.
    const observer = new ResizeObserver(() => {
      if (column.offsetWidth === width) {
        return;
      }
      width = column.offsetWidth;
      const block = place.block?.isConnected ? place.block : undefined;
      const top = scrollTopKeepingPlace({
        scrollTop: viewport.scrollTop,
        maxScrollTop: maxScrollTop(),
        atEnd: place.atEnd,
        blockTop: block ? { before: place.top, now: topOf(block) } : undefined
      });
      if (Math.abs(top - viewport.scrollTop) >= 1) {
        // At once: the viewport scrolls smoothly by its style, which would show the jump.
        viewport.scrollTo({ top, behavior: "instant" });
      }
      noteSoon();
    });
    observer.observe(column);
    viewport.addEventListener("scroll", noteSoon, { passive: true });
    noteSoon();

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      viewport.removeEventListener("scroll", noteSoon);
    };
  }, [columnRef]);
}

/**
 * Keeps what stood above the pinned footer in view when the footer grows, as it does when a
 * notice such as "Opened <name> · Go to it" appears over the composer: the thread moves up by
 * as much as the footer grew, where it can scroll that far, instead of the footer covering its
 * last lines, such as a card that waits for the person. A footer that shrinks moves nothing.
 * `columnRef` is the column that holds the messages and the footer; it scrolls in the element
 * it stands in.
 */
export function useFooterKeepsThreadInView(
  columnRef: RefObject<HTMLElement | null>,
  footerRef: RefObject<HTMLElement | null>
): void {
  useLayoutEffect(() => {
    const footer = footerRef.current;
    const viewport = columnRef.current?.parentElement;
    if (!footer || !viewport || typeof ResizeObserver === "undefined") {
      return undefined;
    }
    let height = footer.offsetHeight;
    const observer = new ResizeObserver(() => {
      const grew = footer.offsetHeight - height;
      height = footer.offsetHeight;
      // A footer that shrank gives a place above the current one, which is never scrolled to.
      const top = Math.min(
        viewport.scrollTop + grew,
        viewport.scrollHeight - viewport.clientHeight
      );
      if (top - viewport.scrollTop >= 1) {
        // At once: the viewport scrolls smoothly by its style, which would show the footer cover
        // the thread first.
        viewport.scrollTo({ top, behavior: "instant" });
      }
    });
    observer.observe(footer);
    return () => observer.disconnect();
  }, [columnRef, footerRef]);
}
