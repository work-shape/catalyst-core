import { Tabs as TabsPrimitive } from "radix-ui";
import { ChevronDown } from "lucide-react";
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { cn } from "../cn";
import { LinkSlot, splitLinkChild } from "../link-slot";
import { CountBadge, type CountBadgeTone } from "../status/count-badge";
import { useUiLabels } from "../ui-root";

// The list scrolls sideways when the tabs do not fit, which would cut a focus line drawn
// outside a tab. So the line sits inside it.
const tabClassName =
  "relative inline-flex h-9 shrink-0 items-center gap-2 border-b-2 border-transparent px-3 text-label whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50";
const selectedTabClassName = "border-primary text-foreground";
// The row's line is drawn inside the row, under the tabs, so the selected tab's underline ends
// on the same edge as the line and covers it. A border would lie outside what the row clips
// when vertical overflow is hidden, and the underline would end one pixel above its edge.
const tabRowClassName =
  "flex min-w-0 gap-1 overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_var(--color-border)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

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
  /**
   * Stands in the row after the tabs and outside the set, such as a `TabsDisclosure` that
   * shows more of them.
   */
  end?: ReactNode;
}

export function TabsList({ className, label, end, ...props }: TabsListProps) {
  if (end === undefined) {
    return (
      <TabsPrimitive.List
        aria-label={label}
        className={cn(tabRowClassName, className)}
        {...props}
      />
    );
  }
  return (
    <div className={cn(tabRowClassName, className)}>
      <TabsPrimitive.List aria-label={label} className="flex shrink-0 gap-1" {...props} />
      {end}
    </div>
  );
}

export interface TabsDisclosureProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "onClick"
> {
  open: boolean;
  onOpenChange(open: boolean): void;
}

/**
 * A line at the end of a tab row that shows or hides tabs most readers need not see, as
 * "Technical details" does for the source of an App. It is no tab: it switches no view.
 */
export function TabsDisclosure({
  className,
  open,
  onOpenChange,
  children,
  ...props
}: TabsDisclosureProps) {
  return (
    <button
      type="button"
      aria-expanded={open}
      data-state={open ? "open" : "closed"}
      className={cn("group/tabs-disclosure", tabClassName, className)}
      onClick={() => onOpenChange(!open)}
      {...props}
    >
      {children}
      <ChevronDown
        aria-hidden="true"
        className="size-4 shrink-0 transition-transform duration-200 ease-out group-data-[state=closed]/tabs-disclosure:-rotate-90"
      />
    </button>
  );
}

export interface TabsTriggerProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "value"> {
  /** The value of the `TabsContent` this tab shows. */
  value: string;
  /** How many the tab holds. It is read out after the label, as "Members, 12 items". */
  count?: number;
  /** `primary` where the count says something waits for the reader. */
  countTone?: CountBadgeTone;
}

/**
 * The count of a tab: the number for the eye, and the number with its noun for a screen
 * reader, which would otherwise read "Members 12". The hidden text is held by the tab, which
 * is positioned, so it does not lengthen the row.
 */
function TabCount({ count, tone }: { count: number; tone: CountBadgeTone }) {
  const labels = useUiLabels("Tabs");
  const spoken = count === 1 ? labels.countOne : labels.countMany.replace("{count}", String(count));
  return (
    <>
      <CountBadge count={count} tone={tone} aria-hidden="true" />
      <span className="sr-only">, {spoken}</span>
    </>
  );
}

export function TabsTrigger({
  className,
  count,
  countTone = "muted",
  children,
  ...props
}: TabsTriggerProps) {
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
      {count === undefined ? null : <TabCount count={count} tone={countTone} />}
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
  countTone?: CountBadgeTone;
  /** Renders the single child, the caller's link element, as the tab. */
  asChild?: boolean;
}

export function TabsLink({
  className,
  selected = false,
  count,
  countTone = "muted",
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
      {count === undefined ? null : <TabCount count={count} tone={countTone} />}
    </LinkSlot>
  );
}
