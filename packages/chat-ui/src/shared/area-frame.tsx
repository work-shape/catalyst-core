import { useEffect, useRef, type ReactNode, type RefObject } from "react";

/**
 * The frame of a full-page area. Nothing floats over it from `md` up, so the page starts at
 * the top edge: a list page at its own top padding, a detail head as the top band, level with
 * the sidebar's first row. The scroll area is the container a sub-rail takes its greatest
 * height from.
 *
 * Below `md` the button that opens the sidebar floats over the page. The page starts below it
 * and its pinned parts stay clear of it, which is what `--layout-page-inset` tells the `Page`.
 * A detail head starts at the top edge there too, with its first row beside that button.
 */
export function AreaFrame({
  ref,
  label,
  children
}: {
  ref: RefObject<HTMLDivElement | null>;
  /** Names the area's landmark. */
  label: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className="grid h-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)] bg-background"
    >
      <div
        ref={ref}
        className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto [container-type:size] max-md:[--layout-page-inset:var(--layout-header)] max-md:[--layout-page-head-inset:0rem] max-md:[--layout-page-head-start:var(--layout-header-control)]"
      >
        {children}
      </div>
    </section>
  );
}

/**
 * Puts the focus on the page title once, when the area opens. Moving between pages inside the
 * sub-rail leaves the focus on the chosen entry.
 */
export function useAreaTitleFocus(ready: boolean) {
  const areaRef = useRef<HTMLDivElement>(null);
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!ready || focusedRef.current) {
      return;
    }
    const title = areaRef.current?.querySelector("h1");
    if (title) {
      focusedRef.current = true;
      title.tabIndex = -1;
      title.focus({ preventScroll: true });
    }
  }, [ready]);

  return areaRef;
}
