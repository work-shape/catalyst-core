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
  // The page's head stays at the top and is as tall as its content makes it on this screen.
  const head = scroller?.querySelector("[data-page-head]")?.getBoundingClientRect().height ?? 0;
  scroller?.scrollBy({
    top: target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - head,
    behavior: "instant"
  });
}
