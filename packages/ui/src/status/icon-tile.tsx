import type { HTMLAttributes } from "react";
import { cn } from "../cn";

export type IconTileSize = "md" | "lg";

/** The hues a tile may take to tell kinds of one thing apart. None of them says a state. */
export type IconTint = "blue" | "green" | "amber" | "violet" | "teal" | "rose";

export const iconTints: readonly IconTint[] = ["blue", "green", "amber", "violet", "teal", "rose"];

/** A tinted tile: a soft fill of the hue under an icon in the hue. */
export const iconTintClassNames: Record<IconTint, string> = {
  blue: "bg-tint-blue/12 text-tint-blue",
  green: "bg-tint-green/12 text-tint-green",
  amber: "bg-tint-amber/12 text-tint-amber",
  violet: "bg-tint-violet/12 text-tint-violet",
  teal: "bg-tint-teal/12 text-tint-teal",
  rose: "bg-tint-rose/12 text-tint-rose"
};

export interface IconTileProps extends HTMLAttributes<HTMLSpanElement> {
  /** The tile takes the accent, for what stands out by its nature. */
  accent?: boolean;
  /** The tile takes a hue, where tiles side by side stand for different kinds. */
  tint?: IconTint;
  size?: IconTileSize;
}

const sizes: Record<IconTileSize, string> = {
  md: "size-7 [&_svg]:size-4",
  lg: "size-9 [&_svg]:size-5"
};

/**
 * The small square an icon stands in where it names what something is: the head of a node of
 * a graph, and the head of the panel about it. A tinted tile tells kinds apart by a hue.
 */
export function IconTile({
  accent = false,
  tint,
  size = "md",
  className,
  ...props
}: IconTileProps) {
  return (
    <span
      data-slot="icon-tile"
      className={cn(
        "grid shrink-0 place-items-center rounded-md",
        tint !== undefined
          ? iconTintClassNames[tint]
          : accent
            ? "bg-primary-soft text-primary-soft-foreground"
            : "bg-secondary",
        sizes[size],
        className
      )}
      {...props}
    />
  );
}
