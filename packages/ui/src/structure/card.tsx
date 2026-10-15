import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../cn";

export type CardPadding = "md" | "lg";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** The inset of the header and the content: `md` is 16 px, `lg` is 24 px. */
  padding?: CardPadding;
}

/**
 * One self-contained object, such as a tile or a confirmation. Not the wrapper of a page section.
 * A card with a `CardTarget` opens as a whole: while the pointer is on its target's area it shows
 * the hover state, and while its target holds the keyboard focus its edge does too. A control
 * above that area keeps the card at rest.
 */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, padding = "lg", ...props },
  ref
) {
  return (
    <div
      ref={ref}
      data-card=""
      data-padding={padding}
      className={cn(
        "group/card rounded-lg border bg-card text-card-foreground",
        "has-[[data-card-target]]:relative has-[[data-card-target]]:transition-colors has-[[data-card-target]:hover]:border-input-strong has-[[data-card-target]:hover]:bg-state-hover has-[[data-card-target]:focus-visible]:border-input-strong",
        className
      )}
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

export interface CardTitleProps extends HTMLAttributes<HTMLHeadingElement> {
  /**
   * The title is an object's name: a long one takes a second line, is then cut and reads
   * whole on hover.
   */
  clamp?: boolean;
}

export const CardTitle = forwardRef<HTMLHeadingElement, CardTitleProps>(function CardTitle(
  { className, clamp = false, children, ...props },
  ref
) {
  return (
    <h2
      ref={ref}
      className={cn("text-title-sm", clamp && "line-clamp-2 wrap-anywhere", className)}
      title={clamp && typeof children === "string" ? children : undefined}
      {...props}
    >
      {children}
    </h2>
  );
});

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

/**
 * The card's actions, under its content: the main one first. In a card laid out as a column it
 * rests on the lower edge, so the actions of cards that stand side by side share a line.
 */
export const CardFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function CardFooter({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          "mt-auto flex flex-wrap items-center gap-2 p-6 pt-0 group-data-[padding=md]/card:p-4 group-data-[padding=md]/card:pt-0",
          className
        )}
        {...props}
      />
    );
  }
);
