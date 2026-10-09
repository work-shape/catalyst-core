import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../cn";

export interface FilterBarProps extends HTMLAttributes<HTMLDivElement> {
  /** The search field. It takes the room the other parts leave. */
  search?: ReactNode;
  /** The filter controls, in the order they narrow the list. */
  filters?: ReactNode;
  /** How many results the filters leave. */
  count?: ReactNode;
  /** Actions on the list, at the end of the row. */
  actions?: ReactNode;
}

/** The row above a list or table. It is layout only: the controls and their state are the caller's. */
export function FilterBar({
  className,
  search,
  filters,
  count,
  actions,
  ...props
}: FilterBarProps) {
  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-3", className)} {...props}>
      {search === undefined ? null : <div className="min-w-56 flex-1">{search}</div>}
      {filters}
      {count === undefined ? null : (
        <span aria-live="polite" className="text-caption whitespace-nowrap text-muted-foreground">
          {count}
        </span>
      )}
      {actions === undefined ? null : (
        <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
