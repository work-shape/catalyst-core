import { HoverCard as HoverCardPrimitive } from "radix-ui";
import { forwardRef, type AnchorHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../cn";
import { useOverlayContainer } from "../ui-root";

export interface HoverCardProps {
  children: ReactNode;
  /** Milliseconds between the pointer arriving and the card opening. */
  openDelay?: number;
  /** Milliseconds between the pointer leaving and the card closing. */
  closeDelay?: number;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?(open: boolean): void;
}

export function HoverCard(props: HoverCardProps) {
  return <HoverCardPrimitive.Root {...props} />;
}

export interface HoverCardTriggerProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  /** Makes the single child element the trigger instead of wrapping it in a link. */
  asChild?: boolean;
}

export const HoverCardTrigger = forwardRef<HTMLAnchorElement, HoverCardTriggerProps>(
  function HoverCardTrigger(props, ref) {
    return <HoverCardPrimitive.Trigger ref={ref} {...props} />;
  }
);

export interface HoverCardContentProps extends HTMLAttributes<HTMLDivElement> {
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  sideOffset?: number;
}

export const HoverCardContent = forwardRef<HTMLDivElement, HoverCardContentProps>(
  function HoverCardContent({ className, align = "center", sideOffset = 6, ...props }, ref) {
    const container = useOverlayContainer("HoverCard");
    if (!container) {
      return null;
    }
    return (
      <HoverCardPrimitive.Portal container={container}>
        <HoverCardPrimitive.Content
          ref={ref}
          align={align}
          sideOffset={sideOffset}
          className={cn(
            "z-(--layer-popover) w-64 rounded-lg border bg-popover p-4 text-popover-foreground shadow-overlay outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
            className
          )}
          {...props}
        />
      </HoverCardPrimitive.Portal>
    );
  }
);
