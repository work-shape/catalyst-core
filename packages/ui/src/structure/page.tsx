import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../cn";

/** The widest the content column grows: 44rem for a form, 64rem for a list, or all the room. */
export type PageWidth = "narrow" | "default" | "wide";

const contentWidths: Record<PageWidth, string> = {
  narrow: "max-w-(--layout-content-narrow)",
  default: "max-w-(--layout-content)",
  wide: "max-w-none"
};

export interface PageProps extends HTMLAttributes<HTMLDivElement> {
  width?: PageWidth;
  /**
   * A `SubRail` in its own column beside the content while the content keeps 40rem. With less
   * room in the page it sits above the content.
   */
  subRail?: ReactNode;
}

/**
 * The content column of a page: the gutter, the widest it grows, and the column of a
 * `SubRail`. Feature code sets no page padding of its own.
 */
export function Page({ className, width = "default", subRail, children, ...props }: PageProps) {
  if (subRail === undefined) {
    return (
      <div
        className={cn(
          "mx-auto w-full min-w-0 px-(--layout-gutter) py-6",
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
      <div className="flex min-w-0 flex-col gap-x-(--layout-gutter) gap-y-2 pb-6 @subrail/page:flex-row @subrail/page:pt-6">
        {subRail}
        <div className={cn("min-w-0 flex-1", contentWidths[width])}>{children}</div>
      </div>
    </div>
  );
}
