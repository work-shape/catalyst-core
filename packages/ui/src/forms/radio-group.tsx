import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import { useId, type ReactNode } from "react";
import { cn } from "../cn";

export type RadioGroupVariant = "card" | "plain";

export interface RadioOption<Value extends string = string> {
  value: Value;
  label: ReactNode;
  /** One line under the label. */
  description?: ReactNode;
  disabled?: boolean;
}

export interface RadioGroupProps<Value extends string = string> {
  /** What is being chosen. It names the group. */
  label: ReactNode;
  /** One line under the options. */
  hint?: ReactNode;
  options: readonly RadioOption<Value>[];
  value?: Value;
  defaultValue?: Value;
  onValueChange?(value: Value): void;
  /** `card` frames each option with its description; `plain` is a list of radios. */
  variant?: RadioGroupVariant;
  disabled?: boolean;
  required?: boolean;
  /** The name the chosen value is submitted under. */
  name?: string;
  className?: string;
}

/** One choice out of a few. The arrow keys move the choice, Tab leaves the group. */
export function RadioGroup<Value extends string = string>({
  label,
  hint,
  options,
  onValueChange,
  variant = "card",
  className,
  ...props
}: RadioGroupProps<Value>) {
  const labelId = useId();
  const hintId = useId();
  const optionId = useId();

  return (
    <RadioGroupPrimitive.Root
      aria-labelledby={labelId}
      aria-describedby={hint === undefined ? undefined : hintId}
      className={cn("grid", variant === "card" ? "gap-2" : "gap-2.5", className)}
      onValueChange={(next) => {
        const option = options.find((candidate) => candidate.value === next);
        if (option) {
          onValueChange?.(option.value);
        }
      }}
      {...props}
    >
      <span id={labelId} className="text-label">
        {label}
      </span>
      {options.map((option, index) => {
        const itemLabelId = `${optionId}-${index}-label`;
        const itemDescriptionId = `${optionId}-${index}-description`;
        return (
          <label
            key={option.value}
            className={cn(
              "grid cursor-pointer grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2.5 has-disabled:cursor-not-allowed has-disabled:opacity-50",
              variant === "card" &&
                "rounded-md border border-input p-3 transition-colors hover:bg-state-hover has-data-[state=checked]:border-ring has-data-[state=checked]:bg-state-selected"
            )}
          >
            <RadioGroupPrimitive.Item
              value={option.value}
              disabled={option.disabled}
              aria-labelledby={itemLabelId}
              aria-describedby={option.description === undefined ? undefined : itemDescriptionId}
              className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-input-strong bg-background transition-colors focus-visible:focus-ring disabled:cursor-not-allowed data-[state=checked]:border-primary"
            >
              <RadioGroupPrimitive.Indicator className="size-2 rounded-full bg-primary" />
            </RadioGroupPrimitive.Item>
            <span className="grid gap-0.5">
              <span id={itemLabelId} className={variant === "card" ? "text-label" : "text-body"}>
                {option.label}
              </span>
              {option.description === undefined ? null : (
                <span id={itemDescriptionId} className="text-caption text-muted-foreground">
                  {option.description}
                </span>
              )}
            </span>
          </label>
        );
      })}
      {hint === undefined ? null : (
        <p id={hintId} className="text-caption text-muted-foreground">
          {hint}
        </p>
      )}
    </RadioGroupPrimitive.Root>
  );
}
