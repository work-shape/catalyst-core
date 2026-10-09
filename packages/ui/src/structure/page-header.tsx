import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../cn";

/**
 * `list` heads a list or settings page: the page name, a description, the primary action.
 * `detail` heads one object: it is 64 px high and stays at the top while the page scrolls.
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
  /** One line under the name. */
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
      className={cn(
        "flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2",
        detail
          ? "sticky top-0 z-(--layer-sticky-header) min-h-(--layout-header) border-b bg-background px-(--layout-gutter) py-2"
          : "pb-6",
        className
      )}
      {...props}
    >
      <div className="flex min-w-0 items-center gap-3">
        {back}
        <div className="grid min-w-0 gap-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Heading className={cn("min-w-0 break-words", detail ? "text-title" : "text-title-lg")}>
              {title}
            </Heading>
            {scope}
            {state}
          </div>
          {description === undefined ? null : (
            <div
              className={cn("min-w-0 text-muted-foreground", detail ? "text-caption" : "text-body")}
            >
              {description}
            </div>
          )}
        </div>
      </div>
      {hasActions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {secondaryActions}
          {primaryAction}
          {overflow}
        </div>
      ) : null}
    </header>
  );
}
