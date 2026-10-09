import type { HTMLAttributes } from "react";
import { cn } from "../cn";

/** What a badge says about its object. `accent` is emphasis that is not a state. */
export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger" | "accent";
export type BadgeAppearance = "soft" | "outline";
export type BadgeSize = "sm" | "md";

// A state is a tint with text in its tone. The accent is filled, as the primary button is.
const softTones: Record<BadgeTone, string> = {
  neutral: "border-transparent bg-state-pressed text-foreground",
  info: "border-transparent bg-info-soft text-info-soft-foreground",
  success: "border-transparent bg-success-soft text-success-soft-foreground",
  warning: "border-transparent bg-warning-soft text-warning-soft-foreground",
  danger: "border-transparent bg-destructive-soft text-destructive-soft-foreground",
  accent: "border-transparent bg-primary text-primary-foreground"
};

const outlineTones: Record<BadgeTone, string> = {
  neutral: "border-input text-foreground",
  info: "border-info-border text-info-soft-foreground",
  success: "border-success-border text-success-soft-foreground",
  warning: "border-warning-border text-warning-soft-foreground",
  danger: "border-destructive-border text-destructive-soft-foreground",
  accent: "border-primary-border text-primary-soft-foreground"
};

const badgeSizes: Record<BadgeSize, string> = {
  sm: "h-5",
  md: "h-5.5"
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  appearance?: BadgeAppearance;
  size?: BadgeSize;
  /** A leading dot in the tone's colour, for a state that is read at a glance down a list. */
  dot?: boolean;
}

export function Badge({
  className,
  tone = "neutral",
  appearance = "soft",
  size = "md",
  dot = false,
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border px-2 text-caption font-medium whitespace-nowrap [&>svg]:size-3 [&>svg]:stroke-2",
        badgeSizes[size],
        appearance === "outline" ? outlineTones[tone] : softTones[tone],
        className
      )}
      {...props}
    >
      {dot ? <span aria-hidden="true" className="size-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}
