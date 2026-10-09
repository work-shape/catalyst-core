import { Collapsible } from "radix-ui";
import { ChevronRight } from "lucide-react";
import type { HTMLAttributes, ReactElement, ReactNode } from "react";
import { cn } from "../cn";
import { LinkSlot } from "../link-slot";

export function List({ className, ...props }: HTMLAttributes<HTMLUListElement>) {
  return <ul className={cn("grid min-w-0 gap-0.5", className)} {...props} />;
}

/** `default` is 44 px high and holds a status line; `compact` is 36 px. */
export type ListRowSize = "default" | "compact";

export interface ListRowProps extends Omit<HTMLAttributes<HTMLLIElement>, "title" | "onClick"> {
  size?: ListRowSize;
  /** An avatar or an icon before the title. */
  leading?: ReactNode;
  title: ReactNode;
  /** One line of status under the title. */
  description?: ReactNode;
  /** Chips after the title, such as the scope. */
  chips?: ReactNode;
  /** When it last changed, at the row's end. */
  time?: ReactNode;
  /** The overflow menu's button or another action. It is not part of what opens the row. */
  actions?: ReactNode;
  /** Keeps `actions` visible. Otherwise they show while the row is hovered or holds the focus. */
  actionsVisible?: boolean;
  /** The row is the chosen one of its list: the selection fill and medium weight. */
  selected?: boolean;
  /** The row opens a page: the caller's link element, which wraps everything but `actions`. */
  link?: ReactElement;
  /** The row is a button. */
  onClick?(): void;
  /** The row unfolds: `children` show below it while it is expanded. */
  expandable?: boolean;
  expanded?: boolean;
  defaultExpanded?: boolean;
  onExpandedChange?(expanded: boolean): void;
  disabled?: boolean;
}

const rowHeights: Record<ListRowSize, string> = {
  default: "min-h-11",
  compact: "min-h-9"
};

/**
 * One object in a list: something the reader opens. The row is a link, a button, an unfolding
 * row or plain, by which of `link`, `onClick` and `expandable` it gets.
 */
export function ListRow({
  className,
  size = "default",
  leading,
  title,
  description,
  chips,
  time,
  actions,
  actionsVisible = false,
  selected = false,
  link,
  onClick,
  expandable = false,
  expanded,
  defaultExpanded,
  onExpandedChange,
  disabled = false,
  children,
  ...props
}: ListRowProps) {
  const interactive = link !== undefined || onClick !== undefined || expandable;
  const mainClassName = cn(
    "flex min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-1 text-left text-body",
    rowHeights[size],
    interactive && "focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-50"
  );
  const main = (
    <>
      {expandable ? (
        <ChevronRight
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground group-data-[state=open]/list-row-trigger:rotate-90"
        />
      ) : null}
      {leading === undefined ? null : <span className="flex shrink-0 items-center">{leading}</span>}
      <span className="grid min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn("truncate", selected && "font-medium")}>{title}</span>
          {chips}
        </span>
        {description === undefined ? null : (
          <span className="truncate text-caption text-muted-foreground">{description}</span>
        )}
      </span>
      {time === undefined ? null : (
        <span className="shrink-0 text-caption whitespace-nowrap text-muted-foreground">
          {time}
        </span>
      )}
    </>
  );
  const current = selected ? "true" : undefined;
  const row = (
    <div
      className={cn(
        "group/list-row flex min-w-0 items-center rounded-md transition-colors",
        interactive && "hover:bg-state-hover",
        selected && "bg-state-selected hover:bg-state-selected"
      )}
    >
      {expandable ? (
        <Collapsible.Trigger
          className={cn(mainClassName, "group/list-row-trigger")}
          disabled={disabled}
        >
          {main}
        </Collapsible.Trigger>
      ) : link ? (
        <LinkSlot link={link} className={mainClassName} aria-current={current}>
          {main}
        </LinkSlot>
      ) : onClick ? (
        <button
          type="button"
          className={mainClassName}
          aria-current={current}
          disabled={disabled}
          onClick={onClick}
        >
          {main}
        </button>
      ) : (
        <div className={mainClassName}>{main}</div>
      )}
      {actions === undefined ? null : (
        <span
          className={cn(
            "mr-1 flex shrink-0 items-center gap-1",
            !actionsVisible &&
              "md:opacity-0 md:group-focus-within/list-row:opacity-100 md:group-hover/list-row:opacity-100"
          )}
        >
          {actions}
        </span>
      )}
    </div>
  );
  if (!expandable) {
    return (
      <li className={cn("min-w-0", className)} {...props}>
        {row}
      </li>
    );
  }
  return (
    <Collapsible.Root
      asChild
      open={expanded}
      defaultOpen={defaultExpanded}
      onOpenChange={onExpandedChange}
    >
      <li className={cn("min-w-0", className)} {...props}>
        {row}
        <Collapsible.Content className="px-2 pt-1 pb-3 text-body">{children}</Collapsible.Content>
      </li>
    </Collapsible.Root>
  );
}
