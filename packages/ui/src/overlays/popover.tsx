import { Popover as PopoverPrimitive } from "radix-ui";
import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../cn";
import { useOverlayContainer } from "../ui-root";

/** The raised surface of an anchored overlay: popover, menu and picker share it. */
export const anchoredPanelClassName =
  "z-(--layer-popover) rounded-lg border bg-popover text-popover-foreground shadow-overlay outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95";

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

const popoverWidths: Record<PopoverSize, string> = {
  sm: "w-64",
  md: "w-76",
  fit: "w-fit"
};

export interface PopoverContentProps extends HTMLAttributes<HTMLDivElement> {
  /** `fit` takes the width of its content. */
  size?: PopoverSize;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
}

export const PopoverContent = forwardRef<HTMLDivElement, PopoverContentProps>(
  function PopoverContent(
    { className, size = "md", align = "start", sideOffset = 6, ...props },
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
          collisionPadding={ANCHORED_COLLISION_PADDING}
          className={cn(
            anchoredPanelClassName,
            "max-h-(--radix-popover-content-available-height) max-w-(--radix-popover-content-available-width) overflow-y-auto p-4",
            popoverWidths[size],
            className
          )}
          {...props}
        />
      </PopoverPrimitive.Portal>
    );
  }
);
