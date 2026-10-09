import { Tooltip as TooltipPrimitive } from "radix-ui";
import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../cn";
import { useOverlayContainer } from "../ui-root";

export interface TooltipProps {
  children: ReactNode;
  /** Milliseconds between the pointer arriving and the tooltip opening. */
  delayDuration?: number;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?(open: boolean): void;
  /** Closes the tooltip as soon as the pointer leaves the trigger, also towards the tooltip. */
  disableHoverableContent?: boolean;
}

export function Tooltip({ delayDuration = 100, ...props }: TooltipProps) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration}>
      <TooltipPrimitive.Root {...props} />
    </TooltipPrimitive.Provider>
  );
}

export interface TooltipTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Makes the single child element the trigger instead of wrapping it in a `button`. */
  asChild?: boolean;
}

export const TooltipTrigger = forwardRef<HTMLButtonElement, TooltipTriggerProps>(
  function TooltipTrigger(props, ref) {
    return <TooltipPrimitive.Trigger ref={ref} {...props} />;
  }
);

export interface TooltipContentProps extends HTMLAttributes<HTMLDivElement> {
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
  /** The keys that do the same, shown after the text. */
  shortcut?: ReactNode;
  /** Called when Escape closes the tooltip. */
  onEscapeKeyDown?(event: KeyboardEvent): void;
}

export function TooltipContent({
  className,
  sideOffset = 6,
  shortcut,
  children,
  ...props
}: TooltipContentProps) {
  const container = useOverlayContainer("Tooltip");
  if (!container) {
    return null;
  }
  return (
    <TooltipPrimitive.Portal container={container}>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          "z-(--layer-tooltip) flex max-w-72 items-center gap-2 rounded-md bg-foreground px-2.5 py-1.5 text-caption text-background shadow-overlay animate-in fade-in-0 zoom-in-95",
          className
        )}
        {...props}
      >
        {children}
        {shortcut === undefined ? null : <kbd className="font-sans opacity-70">{shortcut}</kbd>}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}
