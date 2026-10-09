import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../cn";
import { useSidebarCollapsed } from "../navigation/sidebar-collapsed";
import { Tooltip, TooltipContent, TooltipTrigger } from "../overlays/tooltip";
import { Button } from "./button";

export type IconButtonVariant = "ghost" | "outline";
export type IconButtonSize = "sm" | "md" | "lg";

const iconButtonSizes: Record<IconButtonSize, string> = {
  sm: "size-7",
  md: "size-8",
  lg: "size-9"
};

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-label" | "title"
> {
  /** What the button does. Shown as its tooltip and read as its accessible name. */
  label: string;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  /** The keys that do the same, shown after the label in the tooltip. */
  shortcut?: ReactNode;
}

/**
 * A button that shows only an icon. Its label is required, because the icon alone names
 * nothing. In a collapsed `Sidebar` the tooltip opens to the right, clear of the strip.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, label, variant = "ghost", size = "md", shortcut, type = "button", ...props },
  ref
) {
  const inCollapsedSidebar = useSidebarCollapsed();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          ref={ref}
          type={type}
          variant={variant}
          size="icon"
          className={cn("text-muted-foreground", iconButtonSizes[size], className)}
          aria-label={label}
          {...props}
        />
      </TooltipTrigger>
      <TooltipContent side={inCollapsedSidebar ? "right" : undefined} shortcut={shortcut}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
});
