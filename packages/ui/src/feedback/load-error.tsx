import type { HTMLAttributes, ReactNode } from "react";
import { Button } from "../actions/button";
import { cn } from "../cn";
import { useUiLabels } from "../ui-root";
import { InlineError } from "./inline-error";

export interface LoadErrorProps extends Omit<HTMLAttributes<HTMLParagraphElement>, "children"> {
  /** One sentence that says what could not be loaded. */
  children: ReactNode;
  /** Reads again what failed. */
  onRetry(): void;
}

/**
 * A read that failed, in place of what it would have shown, with the way to ask again. A read
 * that was refused, or found nothing, says so in its own words: neither is solved by asking again.
 */
export function LoadError({ children, onRetry, className, ...props }: LoadErrorProps) {
  const labels = useUiLabels("LoadError");
  return (
    <InlineError
      data-load-error=""
      className={cn("flex flex-wrap items-center justify-between gap-2", className)}
      {...props}
    >
      <span>{children}</span>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {labels.tryAgain}
      </Button>
    </InlineError>
  );
}
