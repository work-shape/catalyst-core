import { Tabs as TabsPrimitive } from "radix-ui";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, HTMLAttributes } from "react";
import { cn } from "../cn";
import { LinkSlot, splitLinkChild } from "../link-slot";
import { CountBadge } from "../status/count-badge";

// The list scrolls sideways when the tabs do not fit, which would cut a focus line drawn
// outside a tab. So the line sits inside it.
const tabClassName =
  "-mb-px inline-flex h-9 shrink-0 items-center gap-2 border-b-2 border-transparent px-3 text-label whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50";
const selectedTabClassName = "border-primary text-foreground";
// Bottom padding contains the tabs' negative margin so neither their underline nor their
// inset focus line is clipped when vertical overflow is hidden.
const tabRowClassName =
  "flex min-w-0 gap-1 overflow-x-auto overflow-y-hidden border-b pb-px [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

export interface TabsProps extends Omit<HTMLAttributes<HTMLDivElement>, "defaultValue" | "dir"> {
  value?: string;
  defaultValue?: string;
  onValueChange?(value: string): void;
}

/**
 * Tabs that switch between views of one object, in place. The arrow keys move between the
 * tabs and select as they go; the list is one tab stop. For tabs that are routes, use
 * `TabsNav` and `TabsLink`.
 */
export function Tabs({ className, ...props }: TabsProps) {
  return <TabsPrimitive.Root className={cn("min-w-0", className)} {...props} />;
}

export interface TabsListProps extends Omit<HTMLAttributes<HTMLDivElement>, "aria-label"> {
  /** Names the set of tabs for assistive technology. */
  label: string;
}

export function TabsList({ className, label, ...props }: TabsListProps) {
  return (
    <TabsPrimitive.List aria-label={label} className={cn(tabRowClassName, className)} {...props} />
  );
}

export interface TabsTriggerProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "value"> {
  /** The value of the `TabsContent` this tab shows. */
  value: string;
  count?: number;
}

export function TabsTrigger({ className, count, children, ...props }: TabsTriggerProps) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        tabClassName,
        "data-[state=active]:border-primary data-[state=active]:text-foreground",
        className
      )}
      {...props}
    >
      {children}
      {count === undefined ? null : <CountBadge count={count} tone="muted" />}
    </TabsPrimitive.Trigger>
  );
}

export interface TabsContentProps extends HTMLAttributes<HTMLDivElement> {
  value: string;
}

export function TabsContent(props: TabsContentProps) {
  return <TabsPrimitive.Content {...props} />;
}

export interface TabsNavProps extends Omit<HTMLAttributes<HTMLElement>, "aria-label"> {
  /** Names the navigation for assistive technology. */
  label: string;
}

/** The same underline tabs for views that are routes: a navigation of the caller's links. */
export function TabsNav({ className, label, ...props }: TabsNavProps) {
  return <nav aria-label={label} className={cn(tabRowClassName, className)} {...props} />;
}

export interface TabsLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  /** This tab's route is open. It is marked with `aria-current="page"`. */
  selected?: boolean;
  count?: number;
  /** Renders the single child, the caller's link element, as the tab. */
  asChild?: boolean;
}

export function TabsLink({
  className,
  selected = false,
  count,
  asChild = false,
  children,
  ...props
}: TabsLinkProps) {
  const { link, label } = asChild
    ? splitLinkChild("TabsLink", children)
    : { link: <a />, label: children };
  return (
    <LinkSlot
      link={link}
      className={cn(tabClassName, selected && selectedTabClassName, className)}
      aria-current={selected ? "page" : undefined}
      {...props}
    >
      {label}
      {count === undefined ? null : <CountBadge count={count} tone="muted" />}
    </LinkSlot>
  );
}
