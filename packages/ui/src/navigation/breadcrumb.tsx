import { ChevronRight } from "lucide-react";
import type { HTMLAttributes, MouseEvent } from "react";
import { cn } from "../cn";

/** One place on the way to where the reader is. */
export interface BreadcrumbItem {
  id: string;
  label: string;
  /** The address of the place, for a place that has one. */
  href?: string;
  /** Called by a plain press. With an address, a press that opens a new tab is left alone. */
  onSelect?(): void;
}

export interface BreadcrumbProps extends Omit<HTMLAttributes<HTMLElement>, "aria-label"> {
  /** Names the navigation for assistive technology. */
  label: string;
  /** The way from the outermost place to the current one, which is the last. */
  items: readonly BreadcrumbItem[];
}

const crumbClassName =
  "min-w-0 truncate rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:focus-ring";

function opensElsewhere(event: MouseEvent): boolean {
  return event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

/**
 * The way from an outer place to the one the reader is in, such as from a Workflow into the
 * Workflow one of its steps starts. Every place but the last leads back to itself; the last is
 * where the reader is and is marked with `aria-current`.
 */
export function Breadcrumb({ label, items, className, ...props }: BreadcrumbProps) {
  return (
    <nav aria-label={label} data-slot="breadcrumb" className={cn("min-w-0", className)} {...props}>
      <ol className="flex min-w-0 items-center gap-1 text-caption">
        {items.map((item, index) => {
          const current = index === items.length - 1;
          return (
            <li key={item.id} className="flex min-w-0 items-center gap-1">
              {index === 0 ? null : (
                <ChevronRight
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
              )}
              {current ? (
                <span aria-current="page" className="min-w-0 truncate font-medium text-foreground">
                  {item.label}
                </span>
              ) : item.href === undefined ? (
                <button type="button" className={crumbClassName} onClick={item.onSelect}>
                  {item.label}
                </button>
              ) : (
                <a
                  href={item.href}
                  className={crumbClassName}
                  onClick={(event) => {
                    if (item.onSelect !== undefined && !opensElsewhere(event)) {
                      event.preventDefault();
                      item.onSelect();
                    }
                  }}
                >
                  {item.label}
                </a>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
