import { forwardRef, type AnchorHTMLAttributes } from "react";
import { cn } from "../cn";

export type TextLinkProps = AnchorHTMLAttributes<HTMLAnchorElement>;

/**
 * A link inside a line of text, such as a name in a page's description. It takes the size of
 * the text around it and stands out by the text colour; a link that is an action of its own is
 * a `Button` of the `link` variant.
 */
export const TextLink = forwardRef<HTMLAnchorElement, TextLinkProps>(function TextLink(
  { className, ...props },
  ref
) {
  return (
    <a
      ref={ref}
      className={cn(
        "rounded-sm text-foreground underline-offset-4 hover:underline focus-visible:focus-ring",
        className
      )}
      {...props}
    />
  );
});
