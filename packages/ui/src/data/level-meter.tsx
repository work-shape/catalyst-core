import type { HTMLAttributes } from "react";
import { cn } from "../cn";

/**
 * How the filled steps are coloured. `neutral` is the text colour at every level, `spectrum`
 * goes from a cool colour at the lowest level to a warm one at the highest, and `tone` is one
 * hue that deepens with the level.
 */
export type LevelMeterScale = "neutral" | "spectrum" | "tone";

export interface LevelMeterProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** What is measured, such as "Usage consumption". It stands before the level in words. */
  label: string;
  /** The level reached, from 1 to `steps`. */
  level: number;
  /** How many steps the scale has. The coloured scales have six colours and spread over them. */
  steps?: number;
  /**
   * The level in words, such as "Moderate". It is always shown: the colour and the number of
   * filled steps repeat it and never stand alone.
   */
  valueLabel: string;
  scale?: LevelMeterScale;
}

// The highest level is a warm orange and not the destructive red: a high level is a property,
// not an error.
const spectrumFills = [
  "bg-level-1",
  "bg-level-2",
  "bg-level-3",
  "bg-level-4",
  "bg-level-5",
  "bg-level-6"
] as const;
const toneFills = [
  "bg-level-tone-1",
  "bg-level-tone-2",
  "bg-level-tone-3",
  "bg-level-tone-4",
  "bg-level-tone-5",
  "bg-level-tone-6"
] as const;

function fillOf(scale: LevelMeterScale, level: number, steps: number): string {
  if (scale === "neutral") {
    return "bg-foreground";
  }
  const fills = scale === "spectrum" ? spectrumFills : toneFills;
  const last = fills.length - 1;
  const index = steps > 1 ? Math.round(((level - 1) / (steps - 1)) * last) : last;
  return fills[index] ?? "bg-foreground";
}

/**
 * A level on a short scale of named steps, such as how much usage a model consumes: what is
 * measured, the level in words and one segment per step. Use Progress for an amount of a whole.
 */
export function LevelMeter({
  className,
  label,
  level,
  steps = 6,
  valueLabel,
  scale = "neutral",
  ...props
}: LevelMeterProps) {
  const count = Math.max(1, Math.floor(steps));
  const reached = Math.min(count, Math.max(1, Math.round(level)));
  const fill = fillOf(scale, reached, count);
  return (
    <div data-slot="level-meter" className={cn("grid min-w-0 gap-1.5", className)} {...props}>
      <div className="flex items-baseline justify-between gap-2 text-caption">
        <span className="min-w-0 text-muted-foreground">{label}</span>
        <span className="shrink-0 font-medium text-foreground">{valueLabel}</span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={1}
        aria-valuemax={count}
        aria-valuenow={reached}
        aria-valuetext={valueLabel}
        className="flex gap-0.5"
      >
        {Array.from({ length: count }, (_, index) => (
          <span
            key={index}
            data-filled={index < reached ? "" : undefined}
            className={cn(
              "h-1 min-w-0 flex-1 rounded-full",
              index < reached ? fill : "bg-state-pressed"
            )}
          />
        ))}
      </div>
    </div>
  );
}
