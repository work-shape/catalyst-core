import { cn } from "../cn";
import { FlowEdge, flowEdgePath } from "./flow-edge";
import type { FlowLaneLayout } from "./flow-layout";
import { flowStatusPresentations } from "./flow-node";
import type { FlowEdgeState, FlowLane, FlowStatus } from "./flow-types";

/** The colour of a lane's status icon beside its name. */
const iconTones: Record<FlowStatus, string> = {
  idle: "",
  running: "text-info",
  waiting: "text-warning",
  done: "text-success",
  doneWithFailures: "text-warning",
  failed: "text-destructive",
  skipped: "text-muted-foreground"
};

/** The line into a lane: taken once the lane has started, and being taken while it runs. */
function forkState(status: FlowStatus = "idle"): FlowEdgeState {
  if (status === "idle") return "rest";
  if (status === "skipped") return "skipped";
  return status === "running" || status === "waiting" ? "active" : "done";
}

/** The line out of a lane: taken once the lane is through. */
function joinState(status: FlowStatus = "idle"): FlowEdgeState {
  if (status === "done" || status === "doneWithFailures") return "done";
  return status === "skipped" ? "skipped" : "rest";
}

export interface FlowLanesProps {
  /** Where the lanes stand, from the group's own corner, as the layout placed them. */
  layout: FlowLaneLayout;
  lanes: readonly FlowLane[];
  /** Under the point where the lanes join. */
  joinLabel?: string;
}

/**
 * The lanes of a group, drawn over its body: the name of each lane above its column, a line
 * from the group's head into every lane and from every lane to the point where they join.
 * Lanes that stand one under the other have their names and the join, and no lines.
 */
export function FlowLanes({ layout, lanes, joinLabel }: FlowLanesProps) {
  const named = new Map(lanes.map((lane) => [lane.id, lane]));
  const through = lanes.every(
    (lane) => lane.status === "done" || lane.status === "doneWithFailures"
  );
  return (
    <div data-slot="flow-lanes" className="pointer-events-none absolute -inset-[1.5px]">
      {layout.side ? (
        <svg aria-hidden="true" className="absolute inset-0 size-full overflow-visible">
          {layout.lanes.map((box) => {
            const status = named.get(box.id)?.status;
            const centre = box.x + box.width / 2;
            return (
              <g key={box.id}>
                <FlowEdge
                  path={flowEdgePath(
                    { ...layout.fork, side: "bottom" },
                    { x: centre, y: box.y + 4, side: "top" }
                  )}
                  state={forkState(status)}
                />
                <FlowEdge
                  path={flowEdgePath(
                    { x: centre, y: box.bottom, side: "bottom" },
                    { ...layout.join, side: "top" }
                  )}
                  state={joinState(status)}
                />
              </g>
            );
          })}
        </svg>
      ) : null}
      {layout.lanes.map((box) => {
        const lane = named.get(box.id);
        if (lane === undefined) return null;
        const status = lane.status ?? "idle";
        const icon = flowStatusPresentations[status].icon;
        return (
          <div
            key={box.id}
            data-slot="flow-lane"
            data-lane-id={box.id}
            data-status={status}
            className="absolute flex items-center justify-center px-1"
            style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
          >
            <span
              className={cn(
                "inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full border bg-background px-2.5 py-0.5 text-caption",
                status === "skipped" && "opacity-55"
              )}
            >
              {icon === null ? null : (
                <span
                  className={cn(
                    "grid size-3.5 shrink-0 place-items-center [&_svg]:size-3.5",
                    iconTones[status]
                  )}
                >
                  {icon}
                </span>
              )}
              <span data-slot="flow-lane-label" className="truncate font-medium text-foreground">
                {lane.label}
              </span>
              {lane.meta === undefined ? null : (
                <span data-slot="flow-lane-meta" className="shrink-0 text-muted-foreground">
                  {lane.meta}
                </span>
              )}
            </span>
          </div>
        );
      })}
      <span
        aria-hidden="true"
        data-slot="flow-join"
        className={cn(
          "absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px] bg-background",
          through ? "border-success" : "border-input-strong"
        )}
        style={{ left: layout.join.x, top: layout.join.y }}
      />
      {joinLabel === undefined ? null : (
        <span
          data-slot="flow-join-label"
          className="absolute -translate-x-1/2 pt-2 text-caption whitespace-nowrap text-muted-foreground"
          style={{ left: layout.join.x, top: layout.join.y }}
        >
          {joinLabel}
        </span>
      )}
    </div>
  );
}
