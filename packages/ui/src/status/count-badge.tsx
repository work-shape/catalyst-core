import type { HTMLAttributes } from "react";
import { cn } from "../cn";

/** `primary` says something waits for you. `muted` is a plain count. */
export type CountBadgeTone = "primary" | "muted";

const COUNT_CAP = 99;

const countTones: Record<CountBadgeTone, string> = {
  primary: "bg-primary text-primary-foreground",
  muted: "bg-state-pressed text-foreground"
};

const dotTones: Record<CountBadgeTone, string> = {
  primary: "bg-primary",
  muted: "bg-muted-foreground"
};

export interface CountBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** The number shown. Above 99 it shows as 99+. */
  count?: number;
  tone?: CountBadgeTone;
  /** A dot without a number, where there is room only to say that something waits. */
  dot?: boolean;
}

export function CountBadge({
  className,
  count = 0,
  tone = "primary",
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
      {count > COUNT_CAP ? `${COUNT_CAP}+` : count}
    </span>
  );
}
