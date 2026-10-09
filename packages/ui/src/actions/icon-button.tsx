import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../cn";
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
}

/** A button that shows only an icon. Its label is required, because the icon alone names nothing. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, label, variant = "ghost", size = "md", type = "button", ...props },
  ref
) {
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
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
});
