import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../cn";

/**
 * `list` heads a list or settings page: the page name, a description, the primary action.
 * `detail` heads one object: it is one row, `--layout-header` high, and stays at the top while
 * the page scrolls. From 768 px up it never wraps: the name is cut and says itself whole in a
 * tooltip. In a narrower window the actions go to a second row only when they do not fit beside
 * the cut name.
 */
export type PageHeaderVariant = "list" | "detail";

export interface PageHeaderProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  variant?: PageHeaderVariant;
  /** A back button or the breadcrumb, before the name. */
  back?: ReactNode;
  /** The page's or the object's name. */
  title: ReactNode;
  /** `1` for the page's own heading; `2` where the header sits inside a page that has one. */
  headingLevel?: 1 | 2;
  /** The scope chip, after the name. */
  scope?: ReactNode;
  /** The state, such as a draft badge. */
  state?: ReactNode;
  /** One line under the name of a `list` head. A `detail` head is one row and shows none. */
  description?: ReactNode;
  secondaryActions?: ReactNode;
  primaryAction?: ReactNode;
  /** The overflow menu's button, always last. */
  overflow?: ReactNode;
}

/**
 * The head of a page. Its slots have one order on every page: back or breadcrumb, name, scope
 * chip, state, secondary actions, primary action, overflow.
 */
export function PageHeader({
  className,
  variant = "list",
  back,
  title,
  headingLevel = 1,
  scope,
  state,
  description,
  secondaryActions,
  primaryAction,
  overflow,
  ...props
}: PageHeaderProps) {
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const detail = variant === "detail";
  const hasActions =
    secondaryActions !== undefined || primaryAction !== undefined || overflow !== undefined;
  return (
    <header
      data-variant={variant}
      // A `PageOutline` measures the pinned head: what it scrolls to rests below it.
      data-page-head={detail ? "" : undefined}
      className={cn(
        "flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2",
        detail
          ? "sticky top-0 z-(--layer-sticky-header) min-h-(--layout-header) border-b bg-background px-(--layout-gutter) py-1 md:flex-nowrap"
          : "pb-6",
        className
      )}
      {...props}
    >
      <div
        className={cn(
          "flex min-w-0 items-center gap-3",
          // Beside a floating control the first row starts after it, at rest and pinned alike.
          // The name gives way before the actions do: it keeps a least width and is cut.
          detail && "flex-1 basis-48 ps-(--layout-page-head-start)"
        )}
      >
        {detail && back !== undefined ? (
          // In a head of several lines the way back stays on the first: at the middle of the
          // head's least height, level with a control that floats beside the head. The head's
          // line is part of that height, so this box reaches one line's width into it.
          <div className="-mb-px flex h-[calc(var(--layout-header)-var(--spacing)*2)] shrink-0 items-center self-start">
            {back}
          </div>
        ) : (
          back
        )}
        <div className="grid min-w-0 gap-0.5">
          <div
            className={cn(
              "flex min-w-0 items-center gap-2",
              // A list title's line is as tall as a control, so the title sits the same with
              // or without an action beside it or a description under it.
              detail ? "*:not-first:shrink-0" : "min-h-9 flex-wrap"
            )}
          >
            <Heading
              // An area puts the focus here when it opens; a title is no control and shows no ring.
              className={cn(
                "min-w-0",
                detail ? "truncate" : "break-words",
                "outline-none",
                detail ? "text-title" : "text-title-lg"
              )}
              title={detail && typeof title === "string" ? title : undefined}
            >
              {title}
            </Heading>
            {scope}
            {state}
          </div>
          {detail || description === undefined ? null : (
            <div className="min-w-0 text-body text-muted-foreground">{description}</div>
          )}
        </div>
      </div>
      {hasActions ? (
        <div
          className={cn("flex shrink-0 flex-wrap items-center gap-2", detail && "md:flex-nowrap")}
        >
          {secondaryActions}
          {primaryAction}
          {overflow}
        </div>
      ) : null}
    </header>
  );
}
