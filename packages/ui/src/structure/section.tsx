import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../cn";
import { CountBadge } from "../status/count-badge";

/** `split` puts the title beside the content where there is room; `stacked` puts it above. */
export type SectionLayout = "split" | "stacked";

export interface SectionProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  layout?: SectionLayout;
  title: ReactNode;
  /** `2` under a page's heading; `3` where the page's header is itself a second-level heading. */
  headingLevel?: 2 | 3;
  description?: ReactNode;
  /** How many things the section holds, after the title. */
  count?: number;
  /** One action for the section, such as adding to it. */
  action?: ReactNode;
  /** More under the description, in the title's column, such as a list that picks what the content shows. */
  aside?: ReactNode;
}

/**
 * One section of a page. It is flat: no frame, no fill, no shadow, and a hairline between it
 * and the next section. Its `id` is the anchor a `SubRail` in `anchors` mode scrolls to. The
 * first section, and one directly under a list `PageHeader`, starts without the top padding.
 */
export function Section({
  className,
  layout = "split",
  title,
  headingLevel = 2,
  description,
  count,
  action,
  aside,
  children,
  ...props
}: SectionProps) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section
      data-layout={layout}
      className={cn(
        "@container min-w-0 border-b py-6 first:pt-0 last:border-b-0 [[data-variant=list]+&]:pt-0",
        className
      )}
      {...props}
    >
      <div
        className={cn(
          "grid min-w-0 gap-4",
          layout === "split" && "@2xl:grid-cols-[14rem_minmax(0,1fr)] @2xl:gap-6"
        )}
      >
        <div className="grid min-w-0 content-start gap-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Heading className="min-w-0 text-heading">{title}</Heading>
            {count === undefined ? null : <CountBadge count={count} tone="muted" />}
            {action === undefined ? null : <div className="ml-auto shrink-0">{action}</div>}
          </div>
          {description === undefined ? null : (
            <p className="text-caption text-muted-foreground">{description}</p>
          )}
          {aside}
        </div>
        {/* Beside an aside the content is as tall as it, so a tall field can fill the height. */}
        <div className={cn("grid min-w-0 gap-5", aside === undefined ? "content-start" : "h-full")}>
          {children}
        </div>
      </div>
    </section>
  );
}
