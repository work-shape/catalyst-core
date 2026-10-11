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
 * The page starts `--layout-page-inset` lower where something floats over the top of its scroll
 * area. Its content scrolls up to the top edge; the sub-rail rests where it is pinned, so it
 * does not move with the content.
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
        {header}
        {subRail === undefined ? (
          <div
            className={cn("mx-auto w-full min-w-0 px-(--layout-gutter) pb-6", contentWidths[width])}
          >
            {children}
          </div>
        ) : (
          <div className="flex min-w-0 flex-col gap-x-(--layout-gutter) px-(--layout-gutter) pb-6 @subrail/page:flex-row">
            {subRail}
            <div className={cn("min-w-0 flex-1", contentWidths[width])}>{children}</div>
          </div>
        )}
      </div>
    );
  }
  if (subRail === undefined) {
    return (
      <div
        className={cn(
          "mx-auto w-full min-w-0 px-(--layout-gutter) pt-[calc(var(--layout-page-inset)+var(--spacing)*6)] pb-6",
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
      {/* The top padding is the sub-rail's pinned position: the rail rests there from the start. */}
      <div className="flex min-w-0 flex-col gap-x-(--layout-gutter) gap-y-2 pt-(--layout-page-inset) pb-6 @subrail/page:flex-row @subrail/page:pt-[calc(var(--layout-page-inset)+var(--spacing)*6)]">
        {subRail}
        <div className={cn("min-w-0 flex-1", contentWidths[width])}>{children}</div>
      </div>
    </div>
  );
}
