import { Slot } from "radix-ui";
import { cva } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../cn";
import { Spinner } from "../feedback/spinner";

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger" | "link";
export type ButtonSize = "sm" | "md" | "lg" | "icon";

// A button is a pill. The filled variants are a surface: a fill, a hairline and the control
// edge, which a press takes away. Primary and danger are tinted, not solid: a soft fill of
// their colour, its line and its strong text. Ghost and link stay flat until hovered.
const buttonVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-2 rounded-full border border-transparent text-label whitespace-nowrap transition-[color,background-color,border-color,box-shadow] focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary:
          "border-primary-border bg-primary-soft text-primary-soft-foreground shadow-control hover:bg-primary/20 active:bg-primary/25 active:shadow-none",
        secondary:
          "border-input bg-secondary text-secondary-foreground shadow-control hover:bg-state-pressed active:shadow-none",
        outline:
          "border-input bg-background text-foreground shadow-control hover:border-input-strong hover:bg-state-hover active:bg-state-pressed active:shadow-none",
        ghost: "hover:bg-state-hover hover:text-foreground active:bg-state-pressed",
        danger:
          "border-destructive-border bg-destructive-soft text-destructive-soft-foreground shadow-control hover:bg-destructive/20 active:shadow-none",
        // No line at its sides: without padding its text starts where the text around it does.
        link: "border-x-0 text-accent-foreground underline-offset-4 hover:underline active:opacity-80"
      },
      size: {
        sm: "h-control-sm px-3",
        md: "h-control-md px-4",
        lg: "h-control-lg px-6",
        icon: "size-control-md"
      }
    }
  }
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Renders the single child element with the button's classes instead of a `button`. */
  asChild?: boolean;
  /** Shows a spinner in place of the content, keeps the width and disables the button. */
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant = "primary",
    size = "md",
    asChild = false,
    loading = false,
    disabled,
    children,
    ...props
  },
  ref
) {
  const classes = cn(buttonVariants({ variant, size }), className);
  if (asChild) {
    return (
      <Slot.Root ref={ref} className={classes} {...props}>
        {children}
      </Slot.Root>
    );
  }
  return (
    <button
      ref={ref}
      className={classes}
      {...props}
      // A button without a type submits the form around it, also through a portal.
      type={props.type ?? "button"}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading ? (
        <>
          <span className="invisible inline-flex items-center gap-2">{children}</span>
          <Spinner className="absolute" />
        </>
      ) : (
        children
      )}
    </button>
  );
});
