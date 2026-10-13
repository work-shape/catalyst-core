import {
  EdgeLabelRenderer,
  Handle,
  Position,
  useStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowState
} from "@xyflow/react";
import { createContext, Fragment, use, useLayoutEffect, useState } from "react";
import { Button } from "../actions/button";
import { cn } from "../cn";
import { Progress, type ProgressPart } from "../feedback/progress";
import type { UiLabels } from "../labels";
import { RegistryIcon } from "../status/registry-icon";
import { useUiLabels } from "../ui-root";
import { FlowEdge, flowEdgePath, type FlowEdgeEnd } from "./flow-edge";
import { FlowGroup } from "./flow-group";
import type { FlowPoint, FlowSize } from "./flow-layout";
import { flowHandleClassName, FlowNode, flowStatusPresentations } from "./flow-node";
import type { FlowDirection, FlowEdgeState, FlowGraphGroup, FlowGraphNode } from "./flow-types";

/** Below this zoom a node shows its icon and title only. */
/** Below this zoom a node is its icon and title: the rest could not be read. */
export const FLOW_COMPACT_ZOOM = 0.6;

/** The states of the edges that meet one node, by where they meet it. */
export interface NodeEnds {
  in: Partial<Record<FlowDirection, FlowEdgeState>>;
  out: Partial<Record<FlowDirection, FlowEdgeState>>;
  exits: Record<string, FlowEdgeState>;
}

type StepData = { item: FlowGraphNode; marked: boolean; ends: NodeEnds; direction: FlowDirection };
type GroupData = { item: FlowGraphGroup; marked: boolean; ends: NodeEnds; box: FlowSize };
export type StepRfNode = Node<StepData, "step">;
export type GroupRfNode = Node<GroupData, "container">;
type EdgeData = { state: FlowEdgeState; label?: string; waypoints?: readonly FlowPoint[] };
export type RfEdge = Edge<EdgeData, "flow">;

export interface EngineContextValue {
  select(id: string): void;
  act(id: string): void;
  report(id: string, size: FlowSize): void;
  collapsed: ReadonlySet<string>;
  toggle(id: string): void;
  selectable: boolean;
}

export const EngineContext = createContext<EngineContextValue | undefined>(undefined);

function useEngine(): EngineContextValue {
  const engine = use(EngineContext);
  if (!engine) {
    throw new Error("A canvas node was rendered outside its canvas.");
  }
  return engine;
}

const compactSelector = (state: ReactFlowState) => state.transform[2] < FLOW_COMPACT_ZOOM;

/** A group's line, on both sides: its head is that much smaller than the group. */
const GROUP_LINE = 3;

/** Reports the element's size to the layout, when it mounts and whenever it changes. */
function useReportedSize(id: string, line = 0): (element: HTMLDivElement | null) => void {
  const { report } = useEngine();
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  // Before the first paint, so the first picture is the laid-out one.
  useLayoutEffect(() => {
    if (!element) {
      return undefined;
    }
    const measure = () =>
      report(id, { width: element.offsetWidth + line, height: element.offsetHeight + line });
    measure();
    // A later change is taken up in the next frame: a layout made while the browser still
    // hands out size changes would change sizes it has not handed out yet.
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [element, id, line, report]);
  return setElement;
}

const sides: Record<Position, FlowEdgeEnd["side"]> = {
  [Position.Left]: "left",
  [Position.Right]: "right",
  [Position.Top]: "top",
  [Position.Bottom]: "bottom"
};

/** The handles of the edges that meet a node on its frame, per axis. */
function FrameHandles({ ends }: { ends: NodeEnds }) {
  const handle = (
    type: "source" | "target",
    axis: FlowDirection,
    state: FlowEdgeState | undefined
  ) =>
    state === undefined ? null : (
      <Handle
        key={`${type}-${axis}`}
        type={type}
        id={`${type === "source" ? "out" : "in"}-${axis}`}
        position={
          axis === "horizontal"
            ? type === "source"
              ? Position.Right
              : Position.Left
            : type === "source"
              ? Position.Bottom
              : Position.Top
        }
        isConnectable={false}
        className={flowHandleClassName(state)}
      />
    );
  return (
    <>
      {handle("target", "horizontal", ends.in.horizontal)}
      {handle("target", "vertical", ends.in.vertical)}
      {handle("source", "horizontal", ends.out.horizontal)}
      {handle("source", "vertical", ends.out.vertical)}
    </>
  );
}

function accessibleName(item: FlowGraphNode | FlowGraphGroup, labels: UiLabels): string {
  const word = flowStatusPresentations[item.status ?? "idle"].label;
  return [item.eyebrow, item.title, word === undefined ? undefined : labels[word]]
    .filter((part) => part !== undefined && part !== "")
    .join(", ");
}

function StepNode({ id, data }: NodeProps<StepRfNode>) {
  const engine = useEngine();
  const labels = useUiLabels("FlowCanvas");
  const compact = useStore(compactSelector);
  const frameRef = useReportedSize(id);
  const { item, ends, direction } = data;
  return (
    <FlowNode
      data-flow-id={id}
      frameRef={frameRef}
      className={direction === "vertical" ? "w-75" : undefined}
      icon={<RegistryIcon name={item.icon} fallback={item.iconFallback} />}
      accent={item.accent}
      eyebrow={item.eyebrow}
      title={item.title}
      summary={item.summary}
      chip={
        item.chip === undefined ? undefined : (
          <>
            <RegistryIcon name={item.chip.icon} family="service" />
            <span className="truncate">{item.chip.label}</span>
          </>
        )
      }
      action={
        item.action === undefined ? undefined : (
          <Button size="sm" variant="outline" onClick={() => engine.act(id)}>
            {item.action.label}
          </Button>
        )
      }
      rows={item.exits?.map((exit) => ({
        id: exit.id,
        label: exit.label,
        handle:
          ends.exits[exit.id] === undefined ? undefined : (
            <Handle
              type="source"
              id={`exit:${exit.id}`}
              position={Position.Right}
              isConnectable={false}
              className={cn(flowHandleClassName(ends.exits[exit.id]), "-right-px")}
            />
          )
      }))}
      footer={item.footer}
      meta={item.meta}
      status={item.status}
      selected={data.marked}
      compact={compact}
      stacked={item.kind === "subflow"}
      label={accessibleName(item, labels)}
      onOpen={engine.selectable ? () => engine.select(id) : undefined}
      handles={<FrameHandles ends={ends} />}
    />
  );
}

function GroupNode({ id, data }: NodeProps<GroupRfNode>) {
  const engine = useEngine();
  const labels = useUiLabels("FlowCanvas");
  const compact = useStore(compactSelector);
  const headRef = useReportedSize(id, GROUP_LINE);
  const { item, ends, box } = data;
  const counts = item.counts;
  const words = [
    item.countsLabel === undefined
      ? undefined
      : {
          key: "counts",
          node: <span className="font-medium text-foreground">{item.countsLabel}</span>
        },
    item.failedLabel === undefined
      ? undefined
      : {
          key: "failed",
          node: (
            <span data-slot="flow-failed" className="font-medium text-destructive">
              {item.failedLabel}
            </span>
          )
        },
    item.note === undefined ? undefined : { key: "note", node: item.note }
  ].filter((word) => word !== undefined);
  const parts: ProgressPart[] =
    counts === undefined
      ? []
      : [
          { value: counts.done ?? 0, tone: "success" },
          { value: counts.failed ?? 0, tone: "danger" },
          { value: counts.running ?? 0, tone: "info" }
        ];
  return (
    <FlowGroup
      data-flow-id={id}
      headRef={headRef}
      style={box}
      icon={<RegistryIcon name={item.icon} fallback={item.iconFallback ?? "repeat"} />}
      accent={item.accent}
      eyebrow={item.eyebrow}
      title={item.title}
      summary={item.summary}
      progress={
        counts === undefined && words.length === 0 ? undefined : (
          <>
            {counts === undefined ? null : (
              <Progress size="sm" label={item.title} max={counts.total} parts={parts} />
            )}
            {words.length === 0 ? null : (
              <p className="text-caption text-muted-foreground">
                {words.map((word, index) => (
                  <Fragment key={word.key}>
                    {index === 0 ? null : " · "}
                    {word.node}
                  </Fragment>
                ))}
              </p>
            )}
          </>
        )
      }
      action={
        item.action === undefined ? undefined : (
          <Button size="sm" variant="outline" onClick={() => engine.act(id)}>
            {item.action.label}
          </Button>
        )
      }
      status={item.status}
      selected={data.marked}
      compact={compact}
      collapsed={engine.collapsed.has(id)}
      onCollapsedChange={() => engine.toggle(id)}
      label={accessibleName(item, labels)}
      onOpen={engine.selectable ? () => engine.select(id) : undefined}
      handles={<FrameHandles ends={ends} />}
    />
  );
}

function EngineEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data
}: EdgeProps<RfEdge>) {
  const path = flowEdgePath(
    { x: sourceX, y: sourceY, side: sides[sourcePosition] },
    { x: targetX, y: targetY, side: sides[targetPosition] },
    data?.waypoints
  );
  return (
    <>
      <FlowEdge path={path} state={data?.state} />
      {data?.label === undefined ? null : (
        <EdgeLabelRenderer>
          <span
            data-slot="flow-edge-label"
            className="absolute rounded-full border bg-background px-2 text-caption whitespace-nowrap text-muted-foreground"
            style={{
              transform: `translate(-50%, -50%) translate(${(sourceX + targetX) / 2}px, ${(sourceY + targetY) / 2}px)`
            }}
          >
            {data.label}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

// Not `group`: the engine draws a frame of its own around a node of that type.
export const nodeTypes = { step: StepNode, container: GroupNode };
export const edgeTypes = { flow: EngineEdge };
