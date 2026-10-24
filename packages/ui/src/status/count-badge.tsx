import type { HTMLAttributes } from "react";
import { cn } from "../cn";

/**
 * `primary` says something waits for you. `info` says work runs on its own, such as an answer
 * that is still being written. `muted` is a plain count.
 */
export type CountBadgeTone = "primary" | "info" | "muted";

const COUNT_CAP = 99;

const countTones: Record<CountBadgeTone, string> = {
  primary: "bg-primary text-primary-foreground",
  info: "bg-info text-info-foreground",
  muted: "bg-state-pressed text-foreground"
};

const dotTones: Record<CountBadgeTone, string> = {
  primary: "bg-primary",
  info: "bg-info",
  muted: "bg-muted-foreground"
};

export interface CountBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** The number shown. Above 99 it shows as 99+, unless `exact`. */
  count?: number;
  /**
   * The whole number, however large: for a count that is the fact a control states, such as
   * how many rows a filter holds. A hint that something waits stays capped.
   */
  exact?: boolean;
  tone?: CountBadgeTone;
  /** A dot without a number, where there is room only to say that something waits. */
  dot?: boolean;
}

export function CountBadge({
  className,
  count = 0,
  tone = "primary",
  exact = false,
  dot = false,
  ...props
}: CountBadgeProps) {
  if (dot) {
    return (
      <span
        className={cn("inline-block size-2 shrink-0 rounded-full", dotTones[tone], className)}
        {...props}
      />
    );
  }
  return (
    <span
      className={cn(
        "inline-grid h-4 min-w-4 shrink-0 place-items-center rounded-full px-1 text-micro tabular-nums",
        countTones[tone],
        className
      )}
      {...props}
    >
      {count > COUNT_CAP && !exact ? `${COUNT_CAP}+` : count}
    </span>
  );
}
