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
  /** A `SubRail` in its own column beside the content. Below 1024 px it sits above it. */
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
  return (
    <div
      className={cn(
        "flex w-full min-w-0 flex-col gap-x-(--layout-gutter) gap-y-2 px-(--layout-gutter) py-6 max-lg:pt-0 lg:flex-row",
        className
      )}
      {...props}
    >
      {subRail}
      <div className={cn("min-w-0 flex-1", contentWidths[width])}>{children}</div>
    </div>
  );
}
