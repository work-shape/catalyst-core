import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { type ComponentProps } from "react";
import { cn } from "./cn";

export const TooltipTrigger = TooltipPrimitive.Trigger;

export function Tooltip({
  delayDuration = 100,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Root>) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration}>
      <TooltipPrimitive.Root {...props} />
    </TooltipPrimitive.Provider>
  );
}

export function TooltipContent({
  className,
  sideOffset = 6,
  ...props
}: ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          "z-[100] max-w-72 rounded-md bg-foreground px-2.5 py-1.5 text-xs text-background shadow-md animate-in fade-in-0 zoom-in-95",
          className
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  );
}
