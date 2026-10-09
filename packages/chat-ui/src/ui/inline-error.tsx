import type { HTMLAttributes } from "react";
import { cn } from "./cn";

/** An error shown beside the content it concerns. Screen readers announce it when it appears. */
export function InlineError({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      role="alert"
      className={cn(
        "rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive",
        className
      )}
      {...props}
    />
  );
}
