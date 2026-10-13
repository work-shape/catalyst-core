import { ChevronDown } from "lucide-react";
import { forwardRef, type SelectHTMLAttributes } from "react";
import { cn } from "../cn";
import { useFieldControl } from "./field-control";
import { fieldFrameClassName, fieldHeights, type FieldSize } from "./input";

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  size?: FieldSize;
  invalid?: boolean;
}

/**
 * The native select, for one of a few plain values. It draws its own chevron: the browser's sits
 * on the field's edge and off the text's centre line. `className` sizes and places the field, so
 * it lands on the frame around the select; the select fills that frame.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, size = "md", invalid, id, required, "aria-describedby": describedBy, ...props },
  ref
) {
  const control = useFieldControl({ id, invalid, required, "aria-describedby": describedBy });
  return (
    <span data-select="" className={cn("relative block w-full min-w-0 font-normal", className)}>
      <select
        ref={ref}
        {...control}
        className={cn(
          "flex cursor-pointer appearance-none truncate pr-9 pl-3 [font-weight:inherit]",
          fieldFrameClassName,
          fieldHeights[size]
        )}
        {...props}
      />
      <ChevronDown
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground",
          props.disabled === true && "opacity-50"
        )}
      />
    </span>
  );
});
