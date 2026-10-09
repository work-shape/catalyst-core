import { Collapsible } from "radix-ui";
import { ChevronRight } from "lucide-react";
import {
  createContext,
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

/** Whether the navigation around an item shows icons only. `Sidebar` sets it. */
export const NavCollapsedContext = createContext(false);

/** True inside a `Sidebar` that is collapsed to icons, for what its header and footer show. */
export function useSidebarCollapsed(): boolean {
  return useContext(NavCollapsedContext);
}

export interface NavItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** A 16 px icon before the label. A collapsed sidebar shows only items that have one. */
  icon?: ReactNode;
  /** The item is where the reader is: the selection fill and medium weight. */
  selected?: boolean;
  count?: number;
  countTone?: CountBadgeTone;
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
  const classes = cn(
    "relative flex h-8 w-full min-w-0 shrink-0 items-center gap-2 rounded-md px-2 text-left text-body text-foreground transition-colors hover:bg-state-hover focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
    collapsed && "w-8 justify-center px-0",
    selected && "bg-state-selected font-medium hover:bg-state-selected",
    className
  );
  const content = collapsed ? (
    <>
      {icon}
      <span className="sr-only">{label}</span>
      {count !== undefined && count > 0 ? (
        <CountBadge dot tone={countTone} className="absolute top-1 right-1" />
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
  if (!collapsed) {
    return item;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{item}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

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

/** A run of navigation items under an optional label. Groups are set apart by space, not by a rule. */
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
        <span id={labelId} className={groupLabelClassName}>
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
        className={cn(
          groupLabelClassName,
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
