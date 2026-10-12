import type { SVGAttributes } from "react";
import { cn } from "../cn";
import type { FlowEdgeState } from "./flow-types";

/** Where an edge leaves or arrives: a point and the side of the node it stands on. */
export interface FlowEdgeEnd {
  x: number;
  y: number;
  side: "left" | "right" | "top" | "bottom";
}

const reach: Record<FlowEdgeEnd["side"], readonly [number, number]> = {
  left: [-1, 0],
  right: [1, 0],
  top: [0, -1],
  bottom: [0, 1]
};

/**
 * The curve between two ends. It leaves and arrives at a right angle to the side it stands on,
 * by half the distance and never by less than a short stub, so two close nodes still get a
 * curve. With waypoints it turns into each of them and runs straight between two on one line.
 */
export function flowEdgePath(
  source: FlowEdgeEnd,
  target: FlowEdgeEnd,
  waypoints: readonly { x: number; y: number }[] = []
): string {
  const horizontal = source.side === "left" || source.side === "right";
  const stops = [source, ...waypoints, target];
  let path = `M${round(source.x)} ${round(source.y)}`;
  for (const [index, to] of stops.entries()) {
    const from = stops[index - 1];
    if (!from) {
      continue;
    }
    const distance = Math.abs(horizontal ? to.x - from.x : to.y - from.y) / 2;
    const pull = Math.max(waypoints.length > 0 ? 0 : horizontal ? 24 : 10, distance);
    const [fromX, fromY] = index === 1 ? reach[source.side] : horizontal ? [1, 0] : [0, 1];
    const [toX, toY] =
      index === stops.length - 1 ? reach[target.side] : horizontal ? [-1, 0] : [0, -1];
    path +=
      `C${round(from.x + fromX * pull)} ${round(from.y + fromY * pull)},` +
      `${round(to.x + toX * pull)} ${round(to.y + toY * pull)},${round(to.x)} ${round(to.y)}`;
  }
  return path;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

const edgeStates: Record<FlowEdgeState, string> = {
  rest: "stroke-input-strong",
  done: "stroke-success",
  // The dashes move towards the target, and stand still under reduced motion.
  active: "animate-flow-dash stroke-info [stroke-dasharray:5_5] motion-reduce:animate-none",
  skipped: "stroke-input"
};

export interface FlowEdgeProps extends Omit<SVGAttributes<SVGPathElement>, "d"> {
  /** The path, as `flowEdgePath` makes it. */
  path: string;
  state?: FlowEdgeState;
}

/** A curved connector between two nodes, inside an `svg`. Its state colours and dashes it. */
export function FlowEdge({ path, state = "rest", className, ...props }: FlowEdgeProps) {
  return (
    <path
      d={path}
      data-slot="flow-edge"
      data-state={state}
      className={cn("fill-none stroke-[1.5]", edgeStates[state], className)}
      {...props}
    />
  );
}
