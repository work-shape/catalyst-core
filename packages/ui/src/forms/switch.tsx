import { Switch as SwitchPrimitive } from "radix-ui";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../cn";
import { useFieldControl } from "./field-control";

export interface SwitchProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "onChange" | "value"
> {
  checked?: boolean;
  defaultChecked?: boolean;
  /**
   * The switch stands for several things of which only some are on: the thumb rests in the
   * middle, and a press turns all of them on. It overrides `checked`.
   */
  mixed?: boolean;
  onCheckedChange?(checked: boolean): void;
  required?: boolean;
  /** The value submitted with a form while the switch is on. */
  value?: string;
}

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch(
  { className, id, required, mixed = false, checked, "aria-describedby": describedBy, ...props },
  ref
) {
  const control = useFieldControl({ id, required, "aria-describedby": describedBy });
  return (
    <SwitchPrimitive.Root
      ref={ref}
      className={cn(
        // The off track is a control with no label inside it, so it takes the strong edge.
        "peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border p-0.5 transition-colors focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=unchecked]:border-input-strong data-[state=unchecked]:bg-input-strong data-[state=mixed]:border-primary data-[state=mixed]:bg-primary-soft",
        className
      )}
      {...control}
      {...props}
      // Off underneath, so a press turns everything on.
      checked={mixed ? false : checked}
      {...(mixed ? { "aria-checked": "mixed" as const, "data-state": "mixed" } : {})}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block size-4.5 rounded-full transition-transform",
          mixed
            ? "translate-x-2.5 bg-primary"
            : "bg-background data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0"
        )}
      />
    </SwitchPrimitive.Root>
  );
});
