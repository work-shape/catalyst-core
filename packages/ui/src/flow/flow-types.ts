import type { ReactElement, ReactNode } from "react";

/**
 * How far one part of a graph has come. `idle` is a part that is only described.
 * `doneWithFailures` is a repeated part that ended with some of its entries failed.
 */
export type FlowStatus =
  "idle" | "running" | "waiting" | "done" | "doneWithFailures" | "failed" | "skipped";

export type FlowChange = "new" | "changed" | "removed" | "unsaved";

/** What a connector says: nothing, that it was taken, that it is being taken, or that it was not. */
export type FlowEdgeState = "rest" | "done" | "active" | "skipped";

/** The graph runs left to right, or top to bottom where there is no room for that. */
export type FlowDirection = "horizontal" | "vertical";

/** A small named object on a node, such as what the step reads from. */
export interface FlowChip {
  label: string;
  /** A key of the icon registry. */
  icon?: string;
  /** The key shown where nothing is registered under `icon`, before the generic service icon. */
  iconFallback?: string;
}

/** One way out of a node that has several, each with a connector of its own. */
export interface FlowExit {
  id: string;
  label: string;
}

/** How many entries of a repeated part are in which state. */
export interface FlowCounts {
  total: number;
  done?: number;
  failed?: number;
  running?: number;
}

/**
 * One path of a `parallel` group. Its parts stand in a column of their own under its name, the
 * columns side by side, and the group goes on where they join.
 */
export interface FlowLane {
  id: string;
  label: string;
  /** How far the path has come, shown beside its name and on the lines into and out of it. */
  status?: FlowStatus;
  /** At the end of the name, such as how long the path took. */
  meta?: string;
}

/** A button on a node or in the head of a group. The canvas reports its press with the node's id. */
export interface FlowAction {
  label: string;
}

interface FlowItemBase {
  id: string;
  /** The group this part stands in. */
  parentId?: string;
  /** The lane of that group the part stands in, where the group has lanes. */
  lane?: string;
  /** A key of the icon registry. An unknown key shows `iconFallback`, then a generic icon. */
  icon?: string;
  /** The generic icon shown when no icon is registered under `icon`. */
  iconFallback?: string;
  /** The icon tile takes the accent, for a part that stands out by its nature. */
  accent?: boolean;
  /** The type of the part in plain words. */
  eyebrow: string;
  title: string;
  /** One sentence on what the part does. */
  summary?: string;
  change?: FlowChange;
  /** The published sentence, shown struck through for a changed item. */
  oldSummary?: string;
  status?: FlowStatus;
  action?: FlowAction;
}

/**
 * One node of the graph. `step` is a plain node, `condition` has one row per exit, and `subflow`
 * is drawn as a stack because it holds a graph of its own.
 */
export interface FlowGraphNode extends FlowItemBase {
  kind: "step" | "condition" | "subflow";
  chip?: FlowChip;
  /** The exits of a `condition`. An edge leaves one of them by naming it as `sourceExit`. */
  exits?: readonly FlowExit[];
  /** What the footer says beside the status icon. Without it a node with a status says the status. */
  footer?: string;
  /** At the end of the footer, such as how long it took. */
  meta?: string;
}

/**
 * A container that holds nodes and other groups. A `loop` holds the parts of one pass, joined by
 * edges. A `parallel` holds parts that have no order among them.
 */
export interface FlowGraphGroup extends FlowItemBase {
  kind: "loop" | "parallel";
  /** Draws a bar of the shares in the head. */
  counts?: FlowCounts;
  /** The amount in words, such as "212 of 600". It is what a screen reader reads for the bar. */
  countsLabel?: string;
  /** The share that failed, in words such as "3 failed". It stands in the failure colour. */
  failedLabel?: string;
  /** A line under the bar. */
  note?: string;
  /** The group starts folded to its head. */
  defaultCollapsed?: boolean;
  /**
   * The paths of a `parallel` group, in their order. Its parts name theirs as `lane`; a part
   * that names none stands under the paths.
   */
  lanes?: readonly FlowLane[];
  /** Where the lanes join, such as "Goes on when all have ended". */
  joinLabel?: string;
}

export interface FlowGraphEdge {
  id?: string;
  source: string;
  target: string;
  /** The exit of a `condition` this edge leaves. */
  sourceExit?: string;
  /** Without a state the edge takes one from the status of what it joins. */
  state?: FlowEdgeState;
}

/**
 * A place where a part can be put: on an edge between two parts, on an exit row of a
 * `condition`, or at the end of a group's body.
 */
export type FlowInsertPlace =
  | { kind: "edge"; source: string; target: string; edgeId?: string }
  | { kind: "exit"; nodeId: string; exitId: string }
  | { kind: "end"; groupId: string };

/**
 * Points on the canvas where a part can be put. `add` shows a "+" at every place, seen while
 * the pointer is over the canvas or the point has the focus. `move` shows a "Move here" target
 * at every place and turns the nodes' own controls off, so the next press picks a place.
 */
export interface FlowInsertPoints {
  mode: "add" | "move";
  /**
   * The place in words. A "+" is named by it alone, so it says what the press does: "Add a step
   * after Load the clients". A "Move here" target says "Move here" and then this: "after Load
   * the clients".
   */
  label(place: FlowInsertPlace): string;
  /** Called with the place whose point was pressed. */
  onPress(place: FlowInsertPlace): void;
  /** Leaves places out, such as those beside the part that moves. Without it every place shows. */
  shows?(place: FlowInsertPlace): boolean;
  /** Called by Escape while the canvas is in `move` mode. */
  onCancel?(): void;
  /**
   * In `add` mode: wraps the "+" of a place in what it opens, such as a `Picker` whose trigger
   * it is, so the list stands by the point. The point still reports its press.
   */
  around?(place: FlowInsertPlace, point: ReactElement): ReactNode;
}

/** A graph as plain data. It carries no positions: the canvas lays it out. */
export interface FlowGraph {
  nodes: readonly FlowGraphNode[];
  groups?: readonly FlowGraphGroup[];
  edges: readonly FlowGraphEdge[];
}
