import type { HTMLAttributes } from "react";
import { cn } from "../cn";
import { useUiLabels } from "../ui-root";
import type { FlowStatus } from "./flow-types";

/** A rectangle in the graph's own measures. */
export interface FlowBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One part of the graph as the minimap draws it. */
export interface FlowMinimapItem extends FlowBox {
  id: string;
  status?: FlowStatus;
  /** A container: drawn as a dashed outline. */
  group?: boolean;
}

export interface FlowMinimapProps extends HTMLAttributes<HTMLDivElement> {
  items: readonly FlowMinimapItem[];
  /** The part of the graph the canvas shows, in the graph's measures. */
  viewport?: FlowBox;
}

const MAP_WIDTH = 184;
const MAP_HEIGHT = 104;
const MAP_INSET = 10;

// A status keeps its colour; a part without one recedes.
const itemTones: Record<FlowStatus, string> = {
  idle: "bg-input-strong opacity-55",
  skipped: "bg-input-strong opacity-30",
  running: "bg-info",
  waiting: "bg-warning",
  done: "bg-success opacity-55",
  failed: "bg-destructive"
};

/**
 * The whole graph small, with the part the canvas shows marked. It is a picture: the graph
 * itself is what a reader and assistive technology use.
 */
export function FlowMinimap({ items, viewport, className, ...props }: FlowMinimapProps) {
  const labels = useUiLabels("FlowMinimap");
  const bounds = boundsOf(items);
  const scale =
    bounds === undefined
      ? 1
      : Math.min(
          (MAP_WIDTH - 2 * MAP_INSET) / Math.max(bounds.width, 1),
          (MAP_HEIGHT - 2 * MAP_INSET) / Math.max(bounds.height, 1)
        );
  const left = bounds === undefined ? 0 : (MAP_WIDTH - bounds.width * scale) / 2 - bounds.x * scale;
  const top =
    bounds === undefined ? 0 : (MAP_HEIGHT - bounds.height * scale) / 2 - bounds.y * scale;
  const place = (box: FlowBox, least: number) => ({
    left: left + box.x * scale,
    top: top + box.y * scale,
    width: Math.max(least, box.width * scale),
    height: Math.max(least, box.height * scale)
  });
  return (
    <div
      role="img"
      aria-label={labels.flowMinimap}
      data-slot="flow-minimap"
      className={cn(
        "pointer-events-auto relative h-26 w-46 overflow-hidden rounded-lg border border-input bg-background shadow-raised",
        className
      )}
      {...props}
    >
      {items.map((item) => (
        <span
          key={item.id}
          data-status={item.status ?? "idle"}
          className={cn(
            "absolute rounded-xs",
            item.group
              ? "border border-dashed border-input-strong"
              : itemTones[item.status ?? "idle"]
          )}
          style={place(item, 2)}
        />
      ))}
      {viewport === undefined ? null : (
        <span
          data-slot="flow-minimap-viewport"
          className="absolute rounded-sm border-[1.5px] border-primary bg-primary-soft"
          style={clampToMap(place(viewport, 6))}
        />
      )}
    </div>
  );
}

/** The mark of what is shown stays inside the map, also when the canvas shows more than the graph. */
function clampToMap(box: { left: number; top: number; width: number; height: number }) {
  const left = Math.max(2, box.left);
  const top = Math.max(2, box.top);
  return {
    left,
    top,
    width: Math.max(6, Math.min(box.left + box.width, MAP_WIDTH - 2) - left),
    height: Math.max(6, Math.min(box.top + box.height, MAP_HEIGHT - 2) - top)
  };
}

/** The smallest rectangle around every box, or nothing for no boxes. */
function boundsOf(boxes: readonly FlowBox[]): FlowBox | undefined {
  if (boxes.length === 0) {
    return undefined;
  }
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  return {
    x,
    y,
    width: Math.max(...boxes.map((box) => box.x + box.width)) - x,
    height: Math.max(...boxes.map((box) => box.y + box.height)) - y
  };
}
