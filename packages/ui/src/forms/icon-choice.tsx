import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import { useId, type ReactNode } from "react";
import { cn } from "../cn";

export interface IconChoiceOption<Value extends string = string> {
  value: Value;
  /** What the icon stands for. It names the option; the icon alone says nothing to a reader. */
  label: string;
  icon: ReactNode;
}

export interface IconChoiceProps<Value extends string = string> {
  /** What is being chosen. It names the group. */
  label: ReactNode;
  /** One line under the icons. */
  hint?: ReactNode;
  options: readonly IconChoiceOption<Value>[];
  value?: Value;
  defaultValue?: Value;
  onValueChange?(value: Value): void;
  disabled?: boolean;
  className?: string;
}

/**
 * One icon out of a few, each on a square that names it. The arrow keys move the choice, Tab
 * leaves the group. The chosen icon's name stands beside the label, so the choice is told in
 * words too.
 */
export function IconChoice<Value extends string = string>({
  label,
  hint,
  options,
  onValueChange,
  className,
  ...props
}: IconChoiceProps<Value>) {
  const labelId = useId();
  const hintId = useId();
  const chosen = options.find((option) => option.value === (props.value ?? props.defaultValue));

  return (
    <div className={cn("grid gap-2", className)}>
      <span className="flex items-baseline gap-2">
        <span id={labelId} className="text-label">
          {label}
        </span>
        {chosen === undefined ? null : (
          <span className="text-caption text-muted-foreground">{chosen.label}</span>
        )}
      </span>
      <RadioGroupPrimitive.Root
        aria-labelledby={labelId}
        aria-describedby={hint === undefined ? undefined : hintId}
        orientation="horizontal"
        className="flex flex-wrap gap-2"
        onValueChange={(next) => {
          const option = options.find((candidate) => candidate.value === next);
          if (option) {
            onValueChange?.(option.value);
          }
        }}
        {...props}
      >
        {options.map((option) => (
          <RadioGroupPrimitive.Item
            key={option.value}
            value={option.value}
            aria-label={option.label}
            title={option.label}
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-md border border-input bg-background text-muted-foreground transition-colors hover:bg-state-hover focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-ring data-[state=checked]:bg-state-selected"
          >
            {option.icon}
          </RadioGroupPrimitive.Item>
        ))}
      </RadioGroupPrimitive.Root>
      {hint === undefined ? null : (
        <p id={hintId} className="text-caption text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}
