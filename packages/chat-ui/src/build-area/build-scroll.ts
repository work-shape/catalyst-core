/**
 * Room left above a section the page scrolls to, for the index that stays at the top of a
 * narrow page.
 */
const SECTION_SCROLL_MARGIN_PX = 64;

/**
 * The element that scrolls the page's content. Only this one is moved: asking the browser to
 * bring an element into view would also move every box around it, the window included.
 */
function scrollParentOf(element: HTMLElement): Element | undefined {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflowY = getComputedStyle(parent).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") {
      return parent;
    }
  }
  return undefined;
}

/** Another page starts at its top, wherever the last one was scrolled to. */
export function scrollPageToTop(page: HTMLElement | null): void {
  if (page) {
    scrollParentOf(page)?.scrollTo({ top: 0, behavior: "instant" });
  }
}

/** Brings the section with `id` inside `within` to the top of what is shown. */
export function scrollToSection(within: HTMLElement | null, id: string): void {
  const target = within?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
  if (!target) {
    return;
  }
  const scroller = scrollParentOf(target);
  scroller?.scrollBy({
    top:
      target.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top -
      SECTION_SCROLL_MARGIN_PX,
    behavior: "instant"
  });
}
