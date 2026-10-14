import { Slot } from "radix-ui";
import { forwardRef, type HTMLAttributes, type ReactElement } from "react";
import { cn } from "../cn";

export type CardPadding = "md" | "lg";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** The inset of the header and the content: `md` is 16 px, `lg` is 24 px. */
  padding?: CardPadding;
}

/**
 * One self-contained object, such as a tile or a confirmation. Not the wrapper of a page section.
 * A card with a `CardTarget` opens as a whole: it shows the hover state, and while its target
 * holds the keyboard focus its edge does too.
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
        "has-[[data-card-target]]:relative has-[[data-card-target]]:transition-colors has-[[data-card-target]]:hover:border-input-strong has-[[data-card-target]]:hover:bg-state-hover has-[[data-card-target]:focus-visible]:border-input-strong",
        className
      )}
      {...props}
    />
  );
});

/**
 * The one way into a card that opens as a whole: the caller's link or button to what the card
 * stands for, such as its main action in the footer. Its own box stays where it is and its
 * clickable area stretches over the card, so a click anywhere on the card is a click on it,
 * and the keyboard meets it once. Every other control in the card stands above that area and
 * keeps its own action. A card whose reader has nowhere to go has no target and opens nothing.
 * The single child takes the props it is given and passes `className` to a library `Button`.
 */
export function CardTarget({ children }: { children: ReactElement }) {
  return (
    <Slot.Root
      data-card-target=""
      // The stretched area is placed against the card, so the target itself is not positioned.
      className="static after:absolute after:inset-0 after:rounded-lg after:content-['']"
    >
      {children}
    </Slot.Root>
  );
}

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
