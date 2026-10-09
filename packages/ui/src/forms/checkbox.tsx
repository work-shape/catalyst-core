import { Check, Minus } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import { forwardRef, useId, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../cn";
import { useFieldControl } from "./field-control";

/** `indeterminate` is the state of a select-all box while only some rows are selected. */
export type CheckboxState = boolean | "indeterminate";

export interface CheckboxProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "onChange" | "value" | "children" | "defaultChecked"
> {
  checked?: CheckboxState;
  defaultChecked?: CheckboxState;
  onCheckedChange?(checked: boolean): void;
  /** The text beside the box. Without it the caller names the box with `aria-label`. */
  label?: ReactNode;
  /** One line under the label. */
  description?: ReactNode;
  invalid?: boolean;
  required?: boolean;
  /** The value submitted with a form while the box is checked. */
  value?: string;
}

export const Checkbox = forwardRef<HTMLButtonElement, CheckboxProps>(function Checkbox(
  {
    className,
    label,
    description,
    invalid,
    required,
    id,
    onCheckedChange,
    "aria-describedby": describedBy,
    ...props
  },
  ref
) {
  const ownId = useId();
  const descriptionId = useId();
  const hasDescription = label !== undefined && description !== undefined;
  const control = useFieldControl({
    id: id ?? (label === undefined ? undefined : ownId),
    invalid,
    required,
    "aria-describedby":
      [describedBy, hasDescription ? descriptionId : undefined]
        .filter((part) => part !== undefined)
        .join(" ") || undefined
  });

  const box = (
    <CheckboxPrimitive.Root
      ref={ref}
      className={cn(
        "group peer inline-flex size-4 shrink-0 items-center justify-center rounded-sm border border-input-strong bg-background text-primary-foreground transition-colors focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=indeterminate]:border-primary data-[state=indeterminate]:bg-primary",
        label !== undefined && "mt-0.5",
        className
      )}
      onCheckedChange={(state) => onCheckedChange?.(state === true)}
      {...control}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex items-center justify-center">
        <Check aria-hidden="true" className="hidden size-3 group-data-[state=checked]:block" />
        <Minus
          aria-hidden="true"
          className="hidden size-3 group-data-[state=indeterminate]:block"
        />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
  if (label === undefined) {
    return box;
  }
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 gap-y-0.5">
      {box}
      <label
        htmlFor={control.id}
        className="text-body peer-disabled:cursor-not-allowed peer-disabled:opacity-50"
      >
        {label}
      </label>
      {description === undefined ? null : (
        <p id={descriptionId} className="col-start-2 text-caption text-muted-foreground">
          {description}
        </p>
      )}
    </div>
  );
});
