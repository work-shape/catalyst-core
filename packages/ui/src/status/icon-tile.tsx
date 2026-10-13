import type { HTMLAttributes } from "react";
import { cn } from "../cn";

export type IconTileSize = "md" | "lg";

export interface IconTileProps extends HTMLAttributes<HTMLSpanElement> {
  /** The tile takes the accent, for what stands out by its nature. */
  accent?: boolean;
  size?: IconTileSize;
}

const sizes: Record<IconTileSize, string> = {
  md: "size-7 [&_svg]:size-4",
  lg: "size-9 [&_svg]:size-5"
};

/**
 * The small square an icon stands in where it names what something is: the head of a node of
 * a graph, and the head of the panel about it.
 */
export function IconTile({ accent = false, size = "md", className, ...props }: IconTileProps) {
  return (
    <span
      data-slot="icon-tile"
      className={cn(
        "grid shrink-0 place-items-center rounded-md",
        accent ? "bg-primary-soft text-primary-soft-foreground" : "bg-secondary",
        sizes[size],
        className
      )}
      {...props}
    />
  );
}
