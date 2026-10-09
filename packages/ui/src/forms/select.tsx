import { forwardRef, type SelectHTMLAttributes } from "react";
import { cn } from "../cn";
import { fieldFrameClassName, fieldHeights, type FieldSize } from "./input";

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  size?: FieldSize;
  invalid?: boolean;
}

/** The native select, for one of a few plain values. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, size = "md", invalid = false, ...props },
  ref
) {
  return (
    <select
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn("flex px-3", fieldFrameClassName, fieldHeights[size], className)}
      {...props}
    />
  );
});
