import { RadioGroup } from "radix-ui";
import type { ButtonHTMLAttributes, HTMLAttributes } from "react";
import { cn } from "../cn";

export type SegmentedControlSize = "sm" | "md";

const traySizes: Record<SegmentedControlSize, string> = {
  sm: "h-6 text-caption font-medium",
  md: "h-control-sm text-label"
};

export interface SegmentedControlProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "aria-label" | "defaultValue" | "dir"
> {
  /** Names the choice for assistive technology. */
  label: string;
  value?: string;
  defaultValue?: string;
  onValueChange?(value: string): void;
  size?: SegmentedControlSize;
  disabled?: boolean;
}

/**
 * One of a few values or modes, all visible at once. It is a radio group: one tab stop, and
 * the arrow keys move the choice. To switch between views of one object, use `Tabs`.
 */
export function SegmentedControl({
  className,
  label,
  size = "md",
  ...props
}: SegmentedControlProps) {
  return (
    <RadioGroup.Root
      aria-label={label}
      orientation="horizontal"
      data-size={size}
      className={cn(
        "group/segmented inline-flex w-fit shrink-0 items-stretch gap-0.5 rounded-md border border-input bg-background p-0.5",
        traySizes[size],
        className
      )}
      {...props}
    />
  );
}

export interface SegmentedControlItemProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "value"
> {
  value: string;
}

export function SegmentedControlItem({ className, ...props }: SegmentedControlItemProps) {
  return (
    <RadioGroup.Item
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-sm px-3 whitespace-nowrap text-muted-foreground group-data-[size=sm]/segmented:px-2 transition-colors hover:text-foreground focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-50 data-[state=checked]:bg-state-pressed data-[state=checked]:text-foreground [&_svg]:size-4 [&_svg]:shrink-0",
        className
      )}
      {...props}
    />
  );
}
