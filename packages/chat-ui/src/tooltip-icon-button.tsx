import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "./ui/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export interface TooltipIconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  tooltip: string;
}

export const tooltipIconButtonClassName =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-4";

export const TooltipIconButton = forwardRef<HTMLButtonElement, TooltipIconButtonProps>(
  function TooltipIconButton({ className, tooltip, "aria-label": ariaLabel, title, ...props }, ref) {
    const tooltipText = title ?? tooltip;
    return (
      <Tooltip delayDuration={100}>
        <TooltipTrigger asChild>
          <button
            ref={ref}
            type="button"
            className={cn(tooltipIconButtonClassName, className)}
            aria-label={ariaLabel ?? tooltipText}
            {...props}
          />
        </TooltipTrigger>
        <TooltipContent>{tooltipText}</TooltipContent>
      </Tooltip>
    );
  }
);
