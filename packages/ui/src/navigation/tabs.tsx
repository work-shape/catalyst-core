import { Tabs as TabsPrimitive } from "radix-ui";
import { ChevronDown } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode
} from "react";
import { cn } from "../cn";
import { LinkSlot, splitLinkChild } from "../link-slot";
import { revealOffset, SCROLL_EDGE_FADE_REM, useScrollEdgeFade } from "../scroll-edge-fade";
import { CountBadge, type CountBadgeTone } from "../status/count-badge";
import { useUiLabels } from "../ui-root";

// The list scrolls sideways when the tabs do not fit, which would cut a focus line drawn
// outside a tab. So the line sits inside it.
const tabClassName =
  "relative inline-flex h-9 shrink-0 items-center gap-2 border-b-2 border-transparent px-3 text-label whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50";
const selectedTabClassName = "border-primary text-foreground";
// The row's line is drawn inside the frame, under the tabs, so the selected tab's underline
// ends on the same edge as the line and covers it. A border would lie outside what the row
// clips when vertical overflow is hidden, and the underline would end one pixel above its edge.
// The line sits on the frame and not on the row that scrolls, so the row's edge fade leaves it
// whole.
const tabFrameClassName = "min-w-0 shadow-[inset_0_-1px_0_var(--color-border)]";
const tabRowClassName =
  "flex min-w-0 gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";
const selectedTabSelector = '[role="tab"][data-state="active"], [aria-current="page"]';

/** The value of the open tab, so that the row re-renders when it changes. */
const SelectedTabContext = createContext<string | undefined>(undefined);

/**
 * A tab row that does not fit scrolls sideways, fades the edge that hides tabs, and keeps the
 * selected tab in view: when the row first shows and whenever another tab is selected. A tab
 * the reader scrolled away from stays where it is until the selection changes.
 */
function useTabRow<Element extends HTMLElement>() {
  const fade = useScrollEdgeFade<Element>([], "x");
  const { ref, onScroll: measure } = fade;
  const revealed = useRef<globalThis.Element | null>(null);
  // Every render: the tabs, their counts and the selection arrive as children, which the
  // fade's observer of the row's size does not see.
  useEffect(() => {
    measure();
    const row = ref.current;
    const selected = row?.querySelector(selectedTabSelector) ?? null;
    if (!row || !selected || selected === revealed.current) {
      return;
    }
    revealed.current = selected;
    const rowBox = row.getBoundingClientRect();
    const tabBox = selected.getBoundingClientRect();
    const rem = Number.parseFloat(getComputedStyle(row.ownerDocument.documentElement).fontSize);
    // A row that scrolls itself and nothing else: `scrollIntoView` would also move the page.
    row.scrollLeft = revealOffset({
      offset: row.scrollLeft,
      visible: row.clientWidth,
      length: row.scrollWidth,
      start: tabBox.left - rowBox.left + row.scrollLeft,
      end: tabBox.right - rowBox.left + row.scrollLeft,
      inset: SCROLL_EDGE_FADE_REM * (Number.isFinite(rem) ? rem : 16)
    });
  });
  return fade;
}

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
export function Tabs({ className, value, defaultValue, onValueChange, ...props }: TabsProps) {
  const [chosen, setChosen] = useState(defaultValue);
  return (
    <SelectedTabContext.Provider value={value ?? chosen}>
      <TabsPrimitive.Root
        className={cn("min-w-0", className)}
        value={value}
        defaultValue={defaultValue}
        onValueChange={(next) => {
          setChosen(next);
          onValueChange?.(next);
        }}
        {...props}
      />
    </SelectedTabContext.Provider>
  );
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

export function TabsList({ className, label, end, style, ...props }: TabsListProps) {
  // Read so that the row re-renders, and reveals the tab, when another one is selected.
  useContext(SelectedTabContext);
  const row = useTabRow<HTMLDivElement>();
  const rowProps = {
    "data-slot": "tab-row",
    ref: row.ref,
    onScroll: row.onScroll,
    style: { ...style, ...row.style }
  };
  if (end === undefined) {
    return (
      <div className={cn(tabFrameClassName, className)}>
        <TabsPrimitive.List
          aria-label={label}
          className={tabRowClassName}
          {...props}
          {...rowProps}
        />
      </div>
    );
  }
  return (
    <div className={cn(tabFrameClassName, className)}>
      <div className={tabRowClassName} {...rowProps}>
        <TabsPrimitive.List aria-label={label} className="flex shrink-0 gap-1" {...props} />
        {end}
      </div>
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
      className={cn("group/tabs-disclosure", tabClassName, "min-w-0 shrink", className)}
      onClick={() => onOpenChange(!open)}
      {...props}
    >
      <span className="truncate" title={typeof children === "string" ? children : undefined}>
        {children}
      </span>
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
export function TabsNav({ className, label, children, ...props }: TabsNavProps) {
  const row = useTabRow<HTMLDivElement>();
  return (
    <nav aria-label={label} className={cn(tabFrameClassName, className)} {...props}>
      <div
        data-slot="tab-row"
        ref={row.ref}
        onScroll={row.onScroll}
        style={row.style}
        className={tabRowClassName}
      >
        {children}
      </div>
    </nav>
  );
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
