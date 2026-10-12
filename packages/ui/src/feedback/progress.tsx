import type { HTMLAttributes } from "react";
import { cn } from "../cn";

/** What the filled part says. `neutral` is an amount with no judgement in it. */
export type ProgressTone = "neutral" | "info" | "success" | "warning" | "danger";
/** `sm` is 4 px high, beside a line of text; `md` is 8 px, on a line of its own. */
export type ProgressSize = "sm" | "md";

/** One share of a bar that shows several, such as what worked and what failed. */
export interface ProgressPart {
  value: number;
  tone: ProgressTone;
}

interface ProgressBaseProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** Names what the bar measures for someone who does not see it. */
  label: string;
  /** What `value` or the parts together reach when the bar is full. */
  max?: number;
  size?: ProgressSize;
  /**
   * The amount in words, such as "412 of 600" or "4 %". It stands after the bar and is what a
   * screen reader reads in place of a percentage.
   */
  valueLabel?: string;
}

interface SingleProgressProps extends ProgressBaseProps {
  /** How far it is. Without a value and without parts the amount is unknown. */
  value?: number;
  tone?: ProgressTone;
  parts?: undefined;
}

interface PartedProgressProps extends ProgressBaseProps {
  /** Several shares in one bar, drawn in this order from the start. */
  parts: readonly ProgressPart[];
  value?: undefined;
  tone?: undefined;
}

export type ProgressProps = SingleProgressProps | PartedProgressProps;

const progressSizes: Record<ProgressSize, string> = {
  sm: "h-1",
  md: "h-2"
};

// A filled part is the text colour or a state's own colour, never the accent.
const progressTones: Record<ProgressTone, string> = {
  neutral: "bg-foreground",
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive"
};

/**
 * A bar for "so many of so many". With `parts` it shows several shares at once; without an
 * amount it says that something is going on and not how far it is. Only the width of a part
 * moves when its amount changes, and nothing moves under reduced motion.
 */
export function Progress({
  className,
  label,
  value,
  max = 100,
  tone = "neutral",
  parts,
  size = "md",
  valueLabel,
  ...props
}: ProgressProps) {
  const shares = parts ?? (value === undefined ? undefined : [{ value, tone }]);
  const widths = shares ? shareWidths(shares, max) : undefined;
  const reached = shares
    ? Math.min(
        Math.max(max, 0),
        shares.reduce((sum, share) => sum + Math.max(share.value, 0), 0)
      )
    : undefined;
  return (
    <div
      data-slot="progress"
      className={cn("flex w-full min-w-0 items-center gap-3", className)}
      {...props}
    >
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={Math.max(max, 0)}
        aria-valuenow={reached}
        aria-valuetext={valueLabel}
        className={cn(
          "flex min-w-0 flex-1 overflow-hidden rounded-full bg-state-pressed",
          progressSizes[size]
        )}
      >
        {shares && widths ? (
          shares.map((share, index) => (
            <span
              key={index}
              data-tone={share.tone}
              className={cn(
                "h-full shrink-0 transition-[width] duration-(--duration-open) ease-out motion-reduce:transition-none",
                progressTones[share.tone]
              )}
              style={{ width: `${widths[index] ?? 0}%` }}
            />
          ))
        ) : (
          <span
            data-indeterminate=""
            className={cn(
              "h-full w-full animate-pulse opacity-40 motion-reduce:animate-none",
              progressTones[tone]
            )}
          />
        )}
      </div>
      {valueLabel === undefined ? null : (
        <span
          aria-hidden="true"
          className="shrink-0 text-caption whitespace-nowrap text-muted-foreground tabular-nums"
        >
          {valueLabel}
        </span>
      )}
    </div>
  );
}

/**
 * Each share's width in percent of the bar. A share below nothing counts as nothing, and
 * shares that together pass `max` stop at the bar's end, the later ones first.
 */
function shareWidths(shares: readonly ProgressPart[], max: number): number[] {
  let room = max > 0 ? 100 : 0;
  return shares.map((share) => {
    const width = max > 0 ? Math.min(room, (Math.max(share.value, 0) / max) * 100) : 0;
    room -= width;
    return width;
  });
}
