import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../cn";

export type CardPadding = "md" | "lg";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** The inset of the header and the content: `md` is 16 px, `lg` is 24 px. */
  padding?: CardPadding;
}

/** One self-contained object, such as a tile or a confirmation. Not the wrapper of a page section. */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, padding = "lg", ...props },
  ref
) {
  return (
    <div
      ref={ref}
      data-padding={padding}
      className={cn("group/card rounded-lg border bg-card text-card-foreground", className)}
      {...props}
    />
  );
});

export const CardHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function CardHeader({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn("grid gap-1.5 p-6 group-data-[padding=md]/card:p-4", className)}
        {...props}
      />
    );
  }
);

export const CardTitle = forwardRef<HTMLHeadingElement, HTMLAttributes<HTMLHeadingElement>>(
  function CardTitle({ className, ...props }, ref) {
    return <h2 ref={ref} className={cn("text-title-sm", className)} {...props} />;
  }
);

export const CardContent = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function CardContent({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          "p-6 pt-0 group-data-[padding=md]/card:p-4 group-data-[padding=md]/card:pt-0",
          className
        )}
        {...props}
      />
    );
  }
);
