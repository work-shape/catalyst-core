import { Check } from "lucide-react";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import { forwardRef, useId, type ButtonHTMLAttributes, type ReactNode } from "react";
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
  if (!container) {
    return null;
  }
  return (
    <DropdownMenuPrimitive.Portal container={container}>
      <DropdownMenuPrimitive.Content
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
  onSelect?(): void;
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
  onSelect,
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
  if (disabledReason === undefined) {
    return (
      <DropdownMenuPrimitive.Item className={classes} disabled={disabled} onSelect={onSelect}>
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
