import { Popover as PopoverPrimitive } from "radix-ui";
import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../cn";
import { useOverlayContainer } from "../ui-root";

/** The layer an anchored overlay sits on, and how it comes and goes. */
const anchoredLayerClassName =
  "z-(--layer-popover) outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95";

/** The raised surface of an anchored overlay: popover, menu and picker share it. */
export const anchoredPanelClassName = `${anchoredLayerClassName} rounded-lg border bg-popover text-popover-foreground shadow-overlay`;

/** The distance an anchored overlay keeps from the viewport edge when it flips or shifts. */
export const ANCHORED_COLLISION_PADDING = 8;

export interface PopoverProps {
  children: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?(open: boolean): void;
}

/**
 * An anchored panel that is not modal. Focus moves in when it opens; Escape and a click
 * outside close it and focus returns to the trigger.
 */
export function Popover(props: PopoverProps) {
  return <PopoverPrimitive.Root {...props} />;
}

export interface PopoverTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Makes the single child element the trigger instead of wrapping it in a `button`. */
  asChild?: boolean;
}

export const PopoverTrigger = forwardRef<HTMLButtonElement, PopoverTriggerProps>(
  function PopoverTrigger(props, ref) {
    return <PopoverPrimitive.Trigger ref={ref} {...props} />;
  }
);

export type PopoverSize = "sm" | "md" | "fit";
export type PopoverSide = "top" | "right" | "bottom" | "left";

const popoverWidths: Record<PopoverSize, string> = {
  sm: "w-64",
  md: "w-76",
  fit: "w-fit"
};

export interface PopoverContentProps extends HTMLAttributes<HTMLDivElement> {
  /** `fit` takes the width of its content. */
  size?: PopoverSize;
  /**
   * `none` leaves out the surface, its padding and its scroll, for content that draws its own
   * surfaces, such as a menu that opens a panel beside itself. It still opens above the page in
   * the overlay container, and flips and shifts to stay in the window.
   */
  surface?: "panel" | "none";
  /**
   * Room kept free on these sides, in pixels, beyond the usual distance from the window's edge:
   * the width of a panel the content opens beside itself, so the content shifts far enough for
   * the panel to show whole.
   */
  reserve?: { left?: number; right?: number };
  /**
   * Called when Escape is pressed, before the popover closes. Content with a level of its own,
   * such as a panel beside a menu, calls `preventDefault()` to close that level instead.
   */
  onEscapeKeyDown?(event: KeyboardEvent): void;
  side?: PopoverSide;
  align?: "start" | "center" | "end";
  sideOffset?: number;
}

export const PopoverContent = forwardRef<HTMLDivElement, PopoverContentProps>(
  function PopoverContent(
    {
      className,
      size = "md",
      surface = "panel",
      reserve = {},
      align = "start",
      sideOffset = 6,
      ...props
    },
    ref
  ) {
    const container = useOverlayContainer("Popover");
    if (!container) {
      return null;
    }
    return (
      <PopoverPrimitive.Portal container={container}>
        <PopoverPrimitive.Content
          ref={ref}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={{
            top: ANCHORED_COLLISION_PADDING,
            right: ANCHORED_COLLISION_PADDING + (reserve.right ?? 0),
            bottom: ANCHORED_COLLISION_PADDING,
            left: ANCHORED_COLLISION_PADDING + (reserve.left ?? 0)
          }}
          className={cn(
            surface === "panel"
              ? cn(
                  anchoredPanelClassName,
                  "max-h-(--radix-popover-content-available-height) max-w-(--radix-popover-content-available-width) overflow-y-auto p-4"
                )
              : anchoredLayerClassName,
            popoverWidths[size],
            className
          )}
          {...props}
        />
      </PopoverPrimitive.Portal>
    );
  }
);
