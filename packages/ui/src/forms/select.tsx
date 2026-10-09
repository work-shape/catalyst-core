import { forwardRef, type SelectHTMLAttributes } from "react";
import { cn } from "../cn";
import { useFieldControl } from "./field-control";
import { fieldFrameClassName, fieldHeights, type FieldSize } from "./input";

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  size?: FieldSize;
  invalid?: boolean;
}

/** The native select, for one of a few plain values. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, size = "md", invalid, id, required, "aria-describedby": describedBy, ...props },
  ref
) {
  const control = useFieldControl({ id, invalid, required, "aria-describedby": describedBy });
  return (
    <select
      ref={ref}
      {...control}
      className={cn("flex px-3", fieldFrameClassName, fieldHeights[size], className)}
      {...props}
    />
  );
});
