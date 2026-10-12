import type { ComponentProps, ReactNode } from "react";
import { cn } from "../cn";

/** The widest the content column grows: 44rem for a form, 64rem for a list, or all the room. */
export type PageWidth = "narrow" | "default" | "wide";

const contentWidths: Record<PageWidth, string> = {
  narrow: "max-w-(--layout-content-narrow)",
  default: "max-w-(--layout-content)",
  wide: "max-w-none"
};

export interface PageProps extends ComponentProps<"div"> {
  width?: PageWidth;
  /**
   * A `SubRail` in its own column beside the content while the content keeps 40rem. With less
   * room in the page it sits above the content.
   */
  subRail?: ReactNode;
  /**
   * A detail `PageHeader` across the whole page, above the sub-rail and the content. It brings
   * the page's gutter itself, so its first and last slot share the edges of what is under it.
   */
  header?: ReactNode;
}

/**
 * The content column of a page: the gutter, the widest it grows, and the column of a
 * `SubRail`. Feature code sets no page padding of its own.
 *
 * The page's first line, its title line, starts `--layout-page-top` below the top edge, so no
 * page begins at the window's edge. It starts `--layout-page-inset` lower again where something
 * floats over the top of the scroll area. A sub-rail with a title heads its column on that line.
 * The content scrolls up to the top edge; the sub-rail rests where it is pinned, so it does not
 * move with the content.
 *
 * A detail header rests with its first row on the title line. The room above it scrolls away:
 * the header pins at the top edge and the sub-rail directly below it. Where the area says the
 * floating control stands beside the head, the head has no room above it and starts at the top
 * edge.
 *
 * A page ends with `--layout-page-end` of empty space below its last element.
 * The space under the page belongs to the content column. On the row it would end the rail's
 * room early and push a rail as tall as the scroll area up at the end of the page.
 */
export function Page({
  className,
  width = "default",
  subRail,
  header,
  children,
  ...props
}: PageProps) {
  if (header !== undefined) {
    // The page is the container its sub-rail measures: the room the page has, not the window.
    return (
      <div className={cn("@container/page w-full min-w-0", className)} {...props}>
        {/* The head's first row is a control high and stands in the middle of the head's least
            height, so this much room above the head puts that row on the title line. An area
            whose floating control stands beside the head sets the head's own inset instead. */}
        <div
          aria-hidden="true"
          data-page-head-room=""
          className="h-[var(--layout-page-head-inset,calc(var(--layout-page-inset)+var(--layout-page-top)-(var(--layout-header)-var(--spacing)*9)/2))]"
        />
        {header}
        {subRail === undefined ? (
          <div
            className={cn(
              "mx-auto w-full min-w-0 px-(--layout-gutter) pb-(--layout-page-end)",
              contentWidths[width]
            )}
          >
            {children}
          </div>
        ) : (
          <div className="flex min-w-0 flex-col gap-x-(--layout-gutter) px-(--layout-gutter) @subrail/page:flex-row">
            {subRail}
            <div className={cn("min-w-0 flex-1 pb-(--layout-page-end)", contentWidths[width])}>
              {children}
            </div>
          </div>
        )}
      </div>
    );
  }
  if (subRail === undefined) {
    return (
      <div
        className={cn(
          "mx-auto w-full min-w-0 px-(--layout-gutter) pt-[calc(var(--layout-page-inset)+var(--layout-page-top))] pb-(--layout-page-end)",
          contentWidths[width],
          className
        )}
        {...props}
      >
        {children}
      </div>
    );
  }
  // The page is the container its sub-rail measures: the room the page has, not the window.
  return (
    <div
      className={cn("@container/page w-full min-w-0 px-(--layout-gutter)", className)}
      {...props}
    >
      {/* The top padding is the sub-rail's pinned position: the rail rests there from the start.
          Above the content the rail brings the room over its own first line. */}
      <div className="flex min-w-0 flex-col gap-x-(--layout-gutter) gap-y-2 pt-(--layout-page-inset) @subrail/page:flex-row @subrail/page:pt-[calc(var(--layout-page-inset)+var(--layout-page-top))]">
        {subRail}
        <div className={cn("min-w-0 flex-1 pb-(--layout-page-end)", contentWidths[width])}>
          {children}
        </div>
      </div>
    </div>
  );
}

export type PageFooterPinned = "always" | "wide";

const pageFooterPinned: Record<PageFooterPinned, string> = {
  always: "sticky bottom-0",
  wide: "sm:sticky sm:bottom-0"
};

/**
 * What stays at the lower edge of a scrolling `Page`, inside its content: a save row and the
 * notices that belong to it. The page's end space is above it, not below: at the end of the
 * page it rests on the lower edge.
 *
 * `pinned="wide"` keeps it at the lower edge only where the window is wide. On a phone it rests
 * at the end of the page: for a footer that holds a notice of several lines, which would stand
 * over the fields it is about.
 */
export function PageFooter({
  pinned = "always",
  className,
  ...props
}: ComponentProps<"div"> & { pinned?: PageFooterPinned }) {
  return (
    <div
      data-page-footer=""
      className={cn(
        pageFooterPinned[pinned],
        "z-(--layer-sticky-header) mt-(--layout-page-end) -mb-(--layout-page-end) border-t bg-background",
        className
      )}
      {...props}
    />
  );
}
