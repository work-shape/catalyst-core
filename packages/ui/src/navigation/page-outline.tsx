import { ChevronDown, CircleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type MouseEvent, type RefObject } from "react";
import { cn } from "../cn";
import { useUiLabels } from "../ui-root";

export interface PageOutlineItem {
  /** The id of the element the outline scrolls to, such as a `Section`. */
  id: string;
  label: string;
  /** How many things the section holds, after its name. */
  count?: number;
  /** The section holds a field with an error: the outline marks it. */
  invalid?: boolean;
}

export interface PageOutlineProps {
  items: readonly PageOutlineItem[];
  /** The page has a sticky detail header: the outline stays below it. */
  belowHeader?: boolean;
  className?: string;
}

/**
 * The sections of the page it stands on, to the right of the content. It only scrolls: a line
 * marks the section at the top of the view and follows the scrolling, and nothing in it looks
 * like the `SubRail`, which opens other pages. A link scrolls to its section and hands the
 * focus to the section's heading, so the next Tab goes into the section.
 *
 * It stands beside the content only while the content keeps 40rem. With less room in its `Page`
 * it is one line above the content that names the section in view and lets the reader choose
 * another; that line scrolls away with the page.
 */
export function PageOutline({ items, belowHeader = false, className }: PageOutlineProps) {
  const labels = useUiLabels("PageOutline");
  const rootRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { value, scrollTo } = useSectionTracking({
    ids: items.map((item) => item.id),
    rootRef,
    listRef
  });

  return (
    <nav
      ref={rootRef}
      aria-label={labels.onThisPage}
      data-page-outline=""
      className={cn(
        "min-w-0 self-start pt-3 @outline/page:sticky @outline/page:w-(--layout-outline) @outline/page:overflow-y-auto @outline/page:pb-1",
        // Beside the content it is pinned where it starts and scrolls on its own when it is
        // longer than the scroll area. Its first line is level with the content's first line.
        belowHeader
          ? "top-(--layout-header) @outline/page:max-h-[calc(100cqh-var(--layout-header))] @outline/page:pt-5"
          : "top-(--layout-page-inset) @outline/page:top-[calc(var(--layout-page-inset)+var(--spacing)*6)] @outline/page:max-h-[calc(100cqh-var(--layout-page-inset)-var(--spacing)*6)] @outline/page:pt-0",
        className
      )}
    >
      <label className="flex min-w-0 items-center gap-1 text-caption text-muted-foreground @outline/page:hidden">
        <span className="shrink-0">{labels.onThisPage}:</span>
        <span className="relative flex min-w-0 items-center">
          <select
            className="h-control-sm max-w-full min-w-0 cursor-pointer appearance-none rounded-sm bg-transparent pr-4 pl-0.5 field-sizing-content text-caption text-muted-foreground focus-visible:focus-ring"
            value={value}
            onChange={(event) => scrollTo(event.currentTarget.value)}
          >
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {optionText(item, labels.sectionHasError)}
              </option>
            ))}
          </select>
          <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-0 size-3" />
        </span>
      </label>
      <div ref={listRef} className="hidden @outline/page:block">
        {/* The navigation carries this name already. */}
        <p
          aria-hidden="true"
          className="pb-2 pl-3 text-micro tracking-wide text-muted-foreground uppercase"
        >
          {labels.onThisPage}
        </p>
        <ul className="border-l">
          {items.map((item) => (
            <li key={item.id}>
              <PageOutlineLink item={item} current={item.id === value} onChoose={scrollTo} />
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}

function optionText(item: PageOutlineItem, hasError: string): string {
  const name = item.count === undefined ? item.label : `${item.label} (${item.count})`;
  return item.invalid ? `${name} – ${hasError}` : name;
}

function PageOutlineLink({
  item,
  current,
  onChoose
}: {
  item: PageOutlineItem;
  current: boolean;
  onChoose(id: string): void;
}) {
  const labels = useUiLabels("PageOutline");
  const follow = (event: MouseEvent) => {
    event.preventDefault();
    onChoose(item.id);
  };
  return (
    <a
      href={`#${item.id}`}
      aria-current={current ? "location" : undefined}
      data-invalid={item.invalid ? "" : undefined}
      onClick={follow}
      className={cn(
        // The marker is the link's own edge, drawn over the list's line.
        "-ml-px flex min-w-0 items-center gap-1 border-l-2 border-transparent py-1 pl-3 text-caption text-muted-foreground transition-colors hover:text-foreground focus-visible:focus-ring",
        current && "border-foreground font-medium text-foreground"
      )}
    >
      <span className="min-w-0 truncate">{item.label}</span>
      {item.count === undefined ? null : (
        <span className="shrink-0 font-normal text-muted-foreground tabular-nums">
          {item.count}
        </span>
      )}
      {item.invalid ? (
        <>
          <CircleAlert aria-hidden="true" className="size-3 shrink-0 text-destructive" />
          <span className="sr-only">{labels.sectionHasError}</span>
        </>
      ) : null}
    </a>
  );
}

interface SectionMeasure {
  /** The vertical position, in the viewport, that a section has reached when it is "current". */
  line: number;
  targets: { id: string; element: HTMLElement }[];
}

/**
 * Which section is at the top of the view, and scrolling to one. The line the sections are
 * measured against is the outline's own top edge while it stands beside the content. The line
 * that stands in for it scrolls away with the page, so there the line is the top of what
 * scrolls, lowered by the sticky head the outline was told of.
 */
function useSectionTracking({
  ids,
  rootRef,
  listRef
}: {
  ids: readonly string[];
  rootRef: RefObject<HTMLElement | null>;
  listRef: RefObject<HTMLElement | null>;
}): { value: string; scrollTo(id: string): void } {
  const [value, setValue] = useState(ids[0] ?? "");
  const valueRef = useRef(value);
  const ownScrollRef = useRef<{ scroller: Element; top: number } | undefined>(undefined);
  // The ids as one string, so a new array with the same ids does not restart the tracking.
  const idsKey = ids.join("\n");

  const select = useCallback((id: string) => {
    if (valueRef.current === id) {
      return;
    }
    valueRef.current = id;
    setValue(id);
  }, []);

  const measure = useCallback((): SectionMeasure | undefined => {
    const root = rootRef.current;
    const list = listRef.current;
    if (!root || !list) {
      return undefined;
    }
    const targets = idsKey.split("\n").flatMap((id) => {
      const element = findById(root, id);
      return element ? [{ id, element }] : [];
    });
    if (getComputedStyle(list).display !== "none") {
      return { line: root.getBoundingClientRect().top, targets };
    }
    const first = targets[0];
    // The outline's `top` is the height of the head it stays below, or nothing.
    const below = Number.parseFloat(getComputedStyle(root).top);
    const scrollerTop = first ? scrollParent(first.element).getBoundingClientRect().top : 0;
    return { line: Math.max(scrollerTop, 0) + (Number.isFinite(below) ? below : 0), targets };
  }, [idsKey, rootRef, listRef]);

  useEffect(() => {
    const follow = () => {
      const measured = measure();
      const first = measured?.targets[0];
      if (!measured || !first) {
        return;
      }
      const last = measured.targets[measured.targets.length - 1] ?? first;
      const scroller = scrollParent(first.element);
      // Where the outline itself scrolled to, its choice stands: a section near the end cannot reach the line.
      const own = ownScrollRef.current;
      if (own?.scroller === scroller && own.top === scroller.scrollTop) {
        return;
      }
      ownScrollRef.current = undefined;
      const atEnd =
        scroller.scrollTop > 0 &&
        scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
      const passed = measured.targets.filter(
        (target) => target.element.getBoundingClientRect().top <= measured.line + 1
      );
      select(atEnd ? last.id : (passed[passed.length - 1] ?? first).id);
    };
    follow();
    // Scroll events do not bubble; capturing on the document hears every scrolling ancestor.
    document.addEventListener("scroll", follow, { capture: true, passive: true });
    window.addEventListener("resize", follow);
    // A section that loads late or opens moves the ones after it without a scroll.
    const resized = new ResizeObserver(follow);
    for (const target of measure()?.targets ?? []) {
      resized.observe(target.element);
    }
    return () => {
      document.removeEventListener("scroll", follow, { capture: true });
      window.removeEventListener("resize", follow);
      resized.disconnect();
    };
  }, [measure, select]);

  const scrollTo = (id: string) => {
    const measured = measure();
    const target = measured?.targets.find((candidate) => candidate.id === id);
    if (!measured || !target) {
      return;
    }
    const scroller = scrollParent(target.element);
    scroller.scrollBy({
      top: target.element.getBoundingClientRect().top - measured.line,
      behavior: "instant"
    });
    ownScrollRef.current = { scroller, top: scroller.scrollTop };
    select(id);
    focusSection(target.element);
  };

  return { value, scrollTo };
}

/**
 * Hands the focus to the section's heading, or to the section where it has none, without
 * scrolling again. What follows in the tab order is then the section's first control.
 */
function focusSection(section: HTMLElement): void {
  const target = section.querySelector<HTMLElement>("h1, h2, h3, h4, h5, h6") ?? section;
  if (!target.hasAttribute("tabindex")) {
    target.tabIndex = -1;
  }
  target.focus({ preventScroll: true });
}

/** The element with `id` in the document or shadow root that `from` lives in. */
function findById(from: HTMLElement, id: string): HTMLElement | null {
  const rootNode = from.getRootNode();
  return rootNode instanceof Document || rootNode instanceof ShadowRoot
    ? rootNode.getElementById(id)
    : null;
}

function scrollParent(element: HTMLElement): Element {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const overflowY = getComputedStyle(parent).overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      parent.scrollHeight > parent.clientHeight
    ) {
      return parent;
    }
  }
  return element.ownerDocument.scrollingElement ?? element.ownerDocument.documentElement;
}
