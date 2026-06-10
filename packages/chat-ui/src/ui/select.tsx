import { forwardRef, type SelectHTMLAttributes } from "react";
import { cn } from "./cn";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, ...props },
  ref
) {
  return (
    <select
      ref={ref}
      className={cn(
        "flex h-10 w-full min-w-0 rounded-md border border-input bg-background px-3 py-1 text-sm text-foreground shadow-xs transition-colors outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    />
  );
});
