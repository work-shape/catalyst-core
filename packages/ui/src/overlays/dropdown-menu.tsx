import { ArrowUpRight, Check, Copy } from "lucide-react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode
} from "react";
import { cn } from "../cn";
import { useOverlayContainer } from "../ui-root";
import { ANCHORED_COLLISION_PADDING, anchoredPanelClassName } from "./popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

export interface DropdownMenuProps {
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?(open: boolean): void;
}

/**
 * A menu of actions on one object. The arrow keys move through the items, Enter runs one and
 * Escape closes the menu and returns focus to the trigger. The destructive item goes last,
 * after a separator.
 */
export function DropdownMenu(props: DropdownMenuProps) {
  return <DropdownMenuPrimitive.Root modal={false} {...props} />;
}

export interface DropdownMenuTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Makes the single child element the trigger instead of wrapping it in a `button`. */
  asChild?: boolean;
}

export const DropdownMenuTrigger = forwardRef<HTMLButtonElement, DropdownMenuTriggerProps>(
  function DropdownMenuTrigger(props, ref) {
    return <DropdownMenuPrimitive.Trigger ref={ref} {...props} />;
  }
);

export interface DropdownMenuContentProps {
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  className?: string;
}

export function DropdownMenuContent({
  className,
  align = "start",
  sideOffset = 6,
  ...props
}: DropdownMenuContentProps) {
  const container = useOverlayContainer("DropdownMenu");
  const contentRef = useRef<HTMLDivElement>(null);
  if (!container) {
    return null;
  }
  return (
    <DropdownMenuPrimitive.Portal container={container}>
      <DropdownMenuPrimitive.Content
        ref={contentRef}
        // The trigger opens and closes the menu by itself. A menu that is fading out stays on
        // the page and still hears a press outside it, so a press on its trigger opened the
        // menu and the fading menu closed it in the same moment: a second quick press did
        // nothing. A press on the trigger is therefore never one that dismisses.
        onInteractOutside={(event) => {
          const triggerId = contentRef.current?.getAttribute("aria-labelledby");
          const trigger = triggerId ? document.getElementById(triggerId) : null;
          if (event.target instanceof Node && trigger?.contains(event.target)) {
            event.preventDefault();
          }
        }}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={ANCHORED_COLLISION_PADDING}
        className={cn(
          anchoredPanelClassName,
          "max-h-(--radix-dropdown-menu-content-available-height) min-w-48 overflow-y-auto p-1",
          className
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

/** The row every menu item and picker option is: 32 high, radius 8, the hover fill when active. */
export const menuRowClassName =
  "relative flex min-h-8 cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-body outline-none select-none [&_svg]:size-4 [&_svg]:shrink-0";

/** A group heading in a menu or a picker: `caption` at medium weight in muted text. */
export const menuGroupHeadingClassName =
  "px-2 py-1.5 text-caption font-medium text-muted-foreground";

const menuItemClassName = cn(
  menuRowClassName,
  "data-highlighted:bg-state-hover data-disabled:pointer-events-none data-disabled:opacity-50 aria-disabled:text-muted-foreground"
);

export type DropdownMenuItemTone = "default" | "danger";

export interface DropdownMenuItemProps {
  children: ReactNode;
  icon?: ReactNode;
  /** The keys that do the same, shown at the item's trailing edge. */
  shortcut?: ReactNode;
  /** `danger` is for the destructive item. */
  tone?: DropdownMenuItemTone;
  disabled?: boolean;
  /**
   * Why the item cannot be used now. The item stays reachable with the keyboard and shows
   * the reason as its tooltip, and it does nothing when chosen.
   */
  disabledReason?: ReactNode;
  /**
   * Where the reason shows. `line` puts it under the item's text, where it is read without a
   * pointer: use it when the reader has to act on the reason. `tooltip` is the default.
   */
  reasonPlacement?: "tooltip" | "line";
  /**
   * Leaves the menu open when the item is chosen, for an item that answers in place, such as
   * a copy item whose label says for a moment that it copied.
   */
  keepOpen?: boolean;
  onSelect?(): void;
  /**
   * An address outside the product. The item is then a link that opens it in a new tab, and
   * shows the mark of a way out at its trailing edge. `onSelect` still runs.
   */
  href?: string;
  /**
   * The name a link item is read by when its text does not say that it opens a new tab, such
   * as "Documentation, opens in a new tab". It starts with the item's text.
   */
  accessibleName?: string;
  className?: string;
}

export function DropdownMenuItem({
  children,
  icon,
  shortcut,
  tone = "default",
  disabled = false,
  disabledReason,
  reasonPlacement = "tooltip",
  keepOpen = false,
  onSelect,
  href,
  accessibleName,
  className
}: DropdownMenuItemProps) {
  const reasonId = useId();
  const content = (
    <>
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut === undefined ? null : (
        <kbd className="font-sans text-caption text-muted-foreground">{shortcut}</kbd>
      )}
    </>
  );
  const classes = cn(
    menuItemClassName,
    tone === "danger" && "text-destructive data-highlighted:bg-destructive-soft",
    className
  );
  if (href !== undefined && disabledReason === undefined && !disabled) {
    return (
      <DropdownMenuPrimitive.Item asChild className={classes} onSelect={onSelect}>
        <a href={href} target="_blank" rel="noopener noreferrer" aria-label={accessibleName}>
          {icon}
          <span className="min-w-0 flex-1 truncate">{children}</span>
          <ArrowUpRight aria-hidden="true" className="size-3.5! text-muted-foreground" />
        </a>
      </DropdownMenuPrimitive.Item>
    );
  }
  if (disabledReason === undefined) {
    return (
      <DropdownMenuPrimitive.Item
        className={classes}
        disabled={disabled}
        onSelect={
          keepOpen
            ? (event) => {
                event.preventDefault();
                onSelect?.();
              }
            : onSelect
        }
      >
        {content}
      </DropdownMenuPrimitive.Item>
    );
  }
  if (reasonPlacement === "line") {
    return (
      <DropdownMenuPrimitive.Item
        aria-disabled="true"
        // The item is named by its text and described by the reason, not named by both.
        aria-labelledby={`${reasonId}-text`}
        aria-describedby={reasonId}
        className={cn(classes, "max-w-72 items-start")}
        // Choosing it keeps the menu open and runs nothing.
        onSelect={(event) => event.preventDefault()}
      >
        {icon === undefined ? null : <span className="flex h-5 items-center">{icon}</span>}
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span id={`${reasonId}-text`} className="truncate">
            {children}
          </span>
          <span id={reasonId} className="text-caption whitespace-normal text-muted-foreground">
            {disabledReason}
          </span>
        </span>
      </DropdownMenuPrimitive.Item>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DropdownMenuPrimitive.Item
          aria-disabled="true"
          className={classes}
          // Choosing it keeps the menu open and runs nothing.
          onSelect={(event) => event.preventDefault()}
        >
          {content}
        </DropdownMenuPrimitive.Item>
      </TooltipTrigger>
      <TooltipContent side="right">{disabledReason}</TooltipContent>
    </Tooltip>
  );
}

/** How long a copy item says that it copied. */
const COPIED_MS = 1500;

export interface DropdownMenuCopyItemProps {
  /** The text put on the clipboard. */
  value: string;
  /** What the item does, such as "Copy ID". */
  children: ReactNode;
  /** What it says for a moment once it copied, such as "ID copied". */
  copiedLabel: string;
  /** Leading icon while it has not copied. Default: the copy mark. */
  icon?: ReactNode;
}

/**
 * An item that puts a text on the clipboard. The menu stays open while its label says that it
 * copied, and a screen reader hears the same.
 */
export function DropdownMenuCopyItem({
  value,
  children,
  copiedLabel,
  icon = <Copy aria-hidden="true" />
}: DropdownMenuCopyItemProps) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) {
      return undefined;
    }
    const timeout = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timeout);
  }, [copied]);
  return (
    <>
      <DropdownMenuItem
        keepOpen
        icon={copied ? <Check aria-hidden="true" /> : icon}
        onSelect={() => {
          navigator.clipboard.writeText(value).then(
            () => setCopied(true),
            () => setCopied(false)
          );
        }}
      >
        {copied ? copiedLabel : children}
      </DropdownMenuItem>
      <span role="status" className="sr-only">
        {copied ? copiedLabel : null}
      </span>
    </>
  );
}

export interface DropdownMenuCheckboxItemProps {
  children: ReactNode;
  icon?: ReactNode;
  checked: boolean;
  onCheckedChange(checked: boolean): void;
  disabled?: boolean;
  className?: string;
}

/** An item that switches something on or off. The menu stays open so several can be set. */
export function DropdownMenuCheckboxItem({
  children,
  icon,
  checked,
  onCheckedChange,
  disabled,
  className
}: DropdownMenuCheckboxItemProps) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      className={cn(menuItemClassName, className)}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onCheckedChange}
      onSelect={(event) => event.preventDefault()}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <DropdownMenuPrimitive.ItemIndicator>
        <Check aria-hidden="true" />
      </DropdownMenuPrimitive.ItemIndicator>
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

export interface DropdownMenuGroupProps {
  /** The group's heading. */
  label?: ReactNode;
  children: ReactNode;
}

export function DropdownMenuGroup({ label, children }: DropdownMenuGroupProps) {
  return (
    <DropdownMenuPrimitive.Group>
      {label === undefined ? null : (
        <DropdownMenuPrimitive.Label className={menuGroupHeadingClassName}>
          {label}
        </DropdownMenuPrimitive.Label>
      )}
      {children}
    </DropdownMenuPrimitive.Group>
  );
}

export function DropdownMenuSeparator() {
  return <DropdownMenuPrimitive.Separator className="-mx-1 my-1 h-px bg-border" />;
}
