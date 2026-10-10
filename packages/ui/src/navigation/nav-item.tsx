import { Collapsible } from "radix-ui";
import { ChevronRight } from "lucide-react";
import {
  useContext,
  useId,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode
} from "react";
import { cn } from "../cn";
import { LinkSlot, splitLinkChild } from "../link-slot";
import { Tooltip, TooltipContent, TooltipTrigger } from "../overlays/tooltip";
import { CountBadge, type CountBadgeTone } from "../status/count-badge";
import { NavGroupLabelPinnedContext, useSidebarCollapsed } from "./sidebar-collapsed";

export interface NavItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** A 16 px icon before the label. A collapsed sidebar shows only items that have one. */
  icon?: ReactNode;
  /** The item is where the reader is: the selection fill and medium weight. */
  selected?: boolean;
  /** How many things wait behind the item. A collapsed sidebar shows it on the icon's corner. */
  count?: number;
  countTone?: CountBadgeTone;
  /** The keys that do the same. A collapsed item shows them in its tooltip. */
  shortcut?: ReactNode;
  /**
   * Marks and actions of the row's object, after the label. They show while the pointer is on
   * the row, while the keyboard is in it and on a touch screen, and take no room otherwise.
   * `className` then styles the row around the item and the slot.
   */
  trailing?: ReactNode;
  /**
   * The trailing slot keeps its room while it is unseen. For a row whose label ends in a mark
   * that shows at rest: the mark then neither lies under the unseen actions nor moves when they
   * appear, so the pointer reaches it.
   */
  trailingKeepsRoom?: boolean;
  /** Renders the single child, a link element, as the item; what is inside it is the label. */
  asChild?: boolean;
}

/**
 * One row of navigation, in a `Sidebar` or a `SubRail`. It is a button unless `asChild` hands
 * it the caller's link.
 */
export function NavItem({
  className,
  icon,
  selected = false,
  count,
  countTone = "primary",
  shortcut,
  trailing,
  trailingKeepsRoom = false,
  asChild = false,
  type = "button",
  children,
  ...props
}: NavItemProps) {
  const collapsed = useSidebarCollapsed();
  if (collapsed && icon === undefined) {
    return null;
  }
  const { link, label } = asChild
    ? splitLinkChild("NavItem", children)
    : { link: undefined, label: children };
  const withTrailing = trailing !== undefined && !collapsed;
  const fill = cn(
    "transition-colors hover:bg-state-hover",
    selected && "bg-state-selected font-medium hover:bg-state-selected"
  );
  const classes = cn(
    "relative flex h-8 w-full min-w-0 shrink-0 items-center gap-2 rounded-md px-2 text-left text-body text-foreground focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
    collapsed && "w-8 justify-center px-0",
    withTrailing ? "w-auto flex-1" : cn(fill, className)
  );
  const content = collapsed ? (
    <>
      {icon}
      <span className="sr-only">{label}</span>
      {count !== undefined && count > 0 ? (
        <CountBadge count={count} tone={countTone} className="absolute -top-0.5 -right-0.5" />
      ) : null}
    </>
  ) : (
    <>
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count === undefined ? null : <CountBadge count={count} tone={countTone} />}
    </>
  );
  const item = link ? (
    <LinkSlot
      link={link}
      className={classes}
      aria-current={selected ? "page" : undefined}
      {...props}
    >
      {content}
    </LinkSlot>
  ) : (
    <button type={type} className={classes} aria-current={selected ? "true" : undefined} {...props}>
      {content}
    </button>
  );
  if (withTrailing) {
    return (
      <div
        data-selected={selected ? "" : undefined}
        className={cn(
          "group/nav-item relative flex h-8 w-full min-w-0 shrink-0 items-center rounded-md",
          fill,
          className
        )}
      >
        {item}
        <span
          className={cn(
            trailingSlotClassName,
            trailingKeepsRoom ? undefined : trailingSlotOutOfFlowClassName
          )}
        >
          {trailing}
        </span>
      </div>
    );
  }
  if (!collapsed) {
    return item;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{item}</TooltipTrigger>
      <TooltipContent side="right" shortcut={shortcut}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

// Unseen until the row is hovered, holds the focus, has an open menu or is on a touch screen.
// What is in it stays in the tab order all the time.
const trailingSlotClassName = cn(
  "flex shrink-0 items-center gap-0.5 pr-0.5 text-muted-foreground opacity-0",
  "group-hover/nav-item:opacity-100",
  "group-focus-within/nav-item:opacity-100",
  "has-[[aria-expanded=true]]:opacity-100",
  "pointer-coarse:opacity-100"
);

// While unseen the slot is also out of the flow, so the label has the whole row.
const trailingSlotOutOfFlowClassName = cn(
  "absolute right-0.5",
  "group-hover/nav-item:static",
  "group-focus-within/nav-item:static",
  "has-[[aria-expanded=true]]:static",
  "pointer-coarse:static"
);

export interface NavGroupProps extends HTMLAttributes<HTMLDivElement> {
  /** The group's name in sentence case. Without it the items stand as an unnamed group. */
  label?: string;
  /** The label folds the group away and shows a caret. */
  collapsible?: boolean;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?(open: boolean): void;
}

const groupLabelClassName =
  "flex h-7 items-center px-2 text-caption font-medium text-muted-foreground";
// In the scrolling body of a sidebar the label stays at the top while its group is in view.
// It takes the room above it along, as padding on the sidebar's surface, so no item shows
// between the label and what stands above the body. Where it rests it stands as without.
// While items lie under it, it carries the fade they pass through: the sidebar marks the label
// that is pinned with `data-pinned-fade`, so the top of the list ends as softly as its bottom.
const pinnedGroupLabelClassName =
  "sticky top-0 z-(--layer-sticky-header) -mt-2 h-9 bg-sidebar pt-2 after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-3 after:bg-linear-to-b after:from-sidebar after:to-transparent after:opacity-0 data-pinned-fade:after:opacity-100";

/**
 * A run of navigation items under an optional label. Groups are set apart by space, not by a
 * rule. In the scrolling body of a `Sidebar` the label stays in view while its items scroll.
 */
export function NavGroup({
  className,
  label,
  collapsible = false,
  open,
  defaultOpen = true,
  onOpenChange,
  children,
  ...props
}: NavGroupProps) {
  const collapsed = useSidebarCollapsed();
  const labelClassName = cn(
    groupLabelClassName,
    useContext(NavGroupLabelPinnedContext) && pinnedGroupLabelClassName
  );
  const labelId = useId();
  const groupClassName = cn("grid min-w-0 gap-0.5", collapsed && "justify-items-center", className);

  // A collapsed sidebar has no room for a label, so a folded group shows its icons too.
  if (label === undefined || collapsed) {
    return (
      <div role="group" aria-label={label} className={groupClassName} {...props}>
        {children}
      </div>
    );
  }
  if (!collapsible) {
    return (
      <div role="group" aria-labelledby={labelId} className={groupClassName} {...props}>
        <span id={labelId} data-nav-group-label="" className={labelClassName}>
          {label}
        </span>
        {children}
      </div>
    );
  }
  return (
    <Collapsible.Root
      role="group"
      aria-labelledby={labelId}
      className={groupClassName}
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      {...props}
    >
      <Collapsible.Trigger
        id={labelId}
        data-nav-group-label=""
        className={cn(
          labelClassName,
          "group/nav-group-label w-full gap-1 rounded-md text-left transition-colors hover:text-foreground focus-visible:focus-ring"
        )}
      >
        {label}
        <ChevronRight
          aria-hidden="true"
          className="size-3 shrink-0 group-data-[state=open]/nav-group-label:rotate-90"
        />
      </Collapsible.Trigger>
      <Collapsible.Content className="grid min-w-0 gap-0.5">{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}
