import type { ReactNode } from "react";

export interface SkipLinkProps {
  /** The id of the element the link moves the focus to. It must take the focus (`tabIndex={-1}`). */
  target: string;
  children: ReactNode;
}

/**
 * The first stop of the keyboard on a page: it shows only while it holds the focus and moves
 * the focus past the navigation into the content. The address stays as it is.
 */
export function SkipLink({ target, children }: SkipLinkProps) {
  return (
    <a
      href={`#${target}`}
      className="sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:top-2 focus-visible:left-2 focus-visible:z-(--layer-tooltip) focus-visible:rounded-md focus-visible:border focus-visible:bg-popover focus-visible:px-3 focus-visible:py-2 focus-visible:text-label focus-visible:text-foreground focus-visible:shadow-overlay focus-visible:focus-ring"
      onClick={(event) => {
        event.preventDefault();
        document.getElementById(target)?.focus();
      }}
    >
      {children}
    </a>
  );
}
