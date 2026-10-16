import { Slot } from "radix-ui";
import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../cn";

/**
 * `field` frames the message field and its controls. `tray` frames what stands just above it,
 * such as messages waiting to be sent.
 */
export type ComposerFrameVariant = "field" | "tray";

export interface ComposerFrameProps extends HTMLAttributes<HTMLDivElement> {
  variant?: ComposerFrameVariant;
  /** Renders the single child element with the frame's classes instead of a `div`. */
  asChild?: boolean;
}

/**
 * The frame of a message composer. Field and tray share the edge, fill, corner and inset, so the
 * tray reads as part of the composer. Only the field is raised; it holds the focus most of the
 * time, so its line steps up then and no ring shows. The content's layout is the caller's.
 */
export const ComposerFrame = forwardRef<HTMLDivElement, ComposerFrameProps>(function ComposerFrame(
  { className, variant = "field", asChild = false, ...props },
  ref
) {
  const Component = asChild ? Slot.Root : "div";
  return (
    <Component
      ref={ref}
      data-composer-frame={variant}
      className={cn(
        "rounded-xl border bg-popover p-1.5",
        variant === "field" && "shadow-raised transition-colors focus-within:border-input",
        className
      )}
      {...props}
    />
  );
});
