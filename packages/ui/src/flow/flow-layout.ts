import { graphlib, layout as layoutGraph } from "@dagrejs/dagre";
import type { FlowBox } from "./flow-minimap";
import type {
  FlowDirection,
  FlowEdgeState,
  FlowGraph,
  FlowGraphGroup,
  FlowGraphNode,
  FlowStatus
} from "./flow-types";

/** The measured size of a node's frame, or of a group's head with the group's own line around it. */
export interface FlowSize {
  width: number;
  height: number;
}

/** An edge as it is drawn: between two parts that show, along one axis. */
interface FlowLaidOutEdge {
  id: string;
  source: string;
  target: string;
  /** The exit row the edge leaves, where the source shows its rows' handles. */
  sourceExit?: string;
  /** The name of the exit, for an edge that leaves a node whose rows carry no handles. */
  label?: string;
  state: FlowEdgeState;
  /** `horizontal` leaves on the right and arrives on the left; `vertical` bottom to top. */
  axis: FlowDirection;
  /**
   * Points the edge passes on its way, for one that goes past parts standing between its ends:
   * it turns into a free lane beside them and out of it again.
   */
  waypoints?: readonly FlowPoint[];
}

export interface FlowPoint {
  x: number;
  y: number;
}

export interface FlowLayout {
  /** Where every part that shows stands, in the graph's own measures. */
  boxes: ReadonlyMap<string, FlowBox>;
  /** The parts that show, in the order of the flow. A group stands before what it holds. */
  order: readonly string[];
  edges: readonly FlowLaidOutEdge[];
  bounds: FlowBox;
}

export interface FlowLayoutInput {
  graph: FlowGraph;
  direction: FlowDirection;
  /** Sizes by id. A part without one is laid out at an estimated size. */
  sizes?: ReadonlyMap<string, FlowSize>;
  /** The groups folded to their head. */
  collapsed?: ReadonlySet<string>;
}

/** The width of a node per direction. A group is wider by its padding on both sides. */
export const FLOW_NODE_WIDTH: Record<FlowDirection, number> = { horizontal: 216, vertical: 300 };
/** Between a group's edge and what it holds. */
export const FLOW_GROUP_PADDING = 14;

const ESTIMATED_HEIGHT = 76;
/** Between two parts that follow each other, and between two that stand side by side. */
const GAPS: Record<FlowDirection, { rank: number; node: number }> = {
  horizontal: { rank: 48, node: 28 },
  vertical: { rank: 28, node: 20 }
};
/** Inside a group the parts stand closer. */
const BODY_GAP = 22;

type Item = (FlowGraphNode | FlowGraphGroup) & { group: boolean };

interface Placed {
  /** Positions of the scope's members, from the scope's own origin. */
  positions: Map<string, FlowBox>;
  /** Waypoints by edge id, from the scope's own origin. */
  routes: Map<string, FlowPoint[]>;
  width: number;
  height: number;
}

/** An edge as one level's layout sees it: between two members of the level. */
interface Join {
  id: string;
  from: string;
  to: string;
  /** The place of the exit row the edge leaves among its node's rows. */
  exitRow?: number;
}

/**
 * Lays a graph out without stored positions. The top level runs in `direction`. A group is one
 * part of the level it stands in, as large as its head and what it holds; inside, its parts run
 * top to bottom whatever the direction, so a group stays narrow. Groups nest to any depth. An
 * edge to or from something inside a folded group is drawn to the group.
 */
export function layoutFlow({ graph, direction, sizes, collapsed }: FlowLayoutInput): FlowLayout {
  const items = new Map<string, Item>();
  for (const group of graph.groups ?? []) {
    items.set(group.id, { ...group, group: true });
  }
  for (const node of graph.nodes) {
    items.set(node.id, { ...node, group: false });
  }

  /** The item and the groups around it, outermost first. A parent that does not exist is no parent. */
  const chainOf = (id: string): string[] => {
    const chain: string[] = [];
    const seen = new Set<string>();
    for (
      let current = items.get(id);
      current && !seen.has(current.id);
      current = current.parentId === undefined ? undefined : items.get(current.parentId)
    ) {
      seen.add(current.id);
      chain.unshift(current.id);
    }
    return chain;
  };
  const chains = new Map([...items.keys()].map((id) => [id, chainOf(id)]));
  const parentOf = (id: string): string | undefined => chains.get(id)?.at(-2);
  /** What shows in place of an item: itself, or the outermost folded group around it. */
  const shownAs = (id: string): string | undefined => {
    const chain = chains.get(id);
    if (!chain) {
      return undefined;
    }
    return chain.slice(0, -1).find((ancestor) => collapsed?.has(ancestor)) ?? id;
  };

  const members = new Map<string | undefined, string[]>();
  for (const id of items.keys()) {
    if (shownAs(id) === id) {
      const scope = parentOf(id);
      members.set(scope, [...(members.get(scope) ?? []), id]);
    }
  }

  // Every edge is drawn between what shows, and counts for the layout of the one level where
  // its two ends, or the groups around them, stand side by side.
  const edges: FlowLaidOutEdge[] = [];
  const scopeEdges = new Map<string | undefined, Join[]>();
  const drawn = new Set<string>();
  for (const [index, edge] of graph.edges.entries()) {
    const source = shownAs(edge.source);
    const target = shownAs(edge.target);
    if (source === undefined || target === undefined || source === target) {
      continue;
    }
    const sourceChain = chains.get(source) ?? [];
    const targetChain = chains.get(target) ?? [];
    let depth = 0;
    while (sourceChain[depth] !== undefined && sourceChain[depth] === targetChain[depth]) {
      depth += 1;
    }
    const from = sourceChain[depth];
    const to = targetChain[depth];
    // One end holds the other: there is nothing to draw between a group and its own part.
    if (from === undefined || to === undefined) {
      continue;
    }
    const scope = depth === 0 ? undefined : sourceChain[depth - 1];
    const axis: FlowDirection = scope === undefined ? direction : "vertical";
    const exit = source === edge.source ? edge.sourceExit : undefined;
    const key = `${source}\u0000${exit ?? ""}\u0000${target}`;
    if (drawn.has(key)) {
      continue;
    }
    drawn.add(key);
    const sourceItem = items.get(source);
    const exits = sourceItem !== undefined && "exits" in sourceItem ? sourceItem.exits : undefined;
    const exitRow = exits?.findIndex((candidate) => candidate.id === exit) ?? -1;
    const exitLabel = exits?.[exitRow]?.label;
    const id = edge.id ?? `${source}-${exit ?? ""}-${target}-${index}`;
    scopeEdges.set(scope, [
      ...(scopeEdges.get(scope) ?? []),
      { id, from, to, exitRow: from === source && exitRow >= 0 ? exitRow : undefined }
    ]);
    edges.push({
      id,
      source,
      target,
      // Rows carry handles where the flow leaves sideways; below a node the edge names its exit.
      sourceExit: axis === "horizontal" ? exit : undefined,
      label: axis === "vertical" ? exitLabel : undefined,
      state:
        edge.state ?? edgeStateOf(items.get(edge.source)?.status, items.get(edge.target)?.status),
      axis
    });
  }

  const nodeWidth = FLOW_NODE_WIDTH[direction];
  const placedScopes = new Map<string, Placed>();

  const sizeOf = (id: string): FlowSize => {
    const item = items.get(id);
    const measured = sizes?.get(id);
    if (!item?.group) {
      return measured ?? { width: nodeWidth, height: ESTIMATED_HEIGHT };
    }
    // A group is as wide as what it holds, and at least as wide as a node with its padding.
    // Only the height of its head is measured.
    const head = {
      width: nodeWidth + 2 * FLOW_GROUP_PADDING,
      height: measured?.height ?? ESTIMATED_HEIGHT
    };
    if (collapsed?.has(id)) {
      return head;
    }
    const body = placeScope(id);
    placedScopes.set(id, body);
    return {
      width: Math.max(head.width, body.width + 2 * FLOW_GROUP_PADDING),
      height: head.height + body.height + 2 * FLOW_GROUP_PADDING
    };
  };

  const placeScope = (scope: string | undefined): Placed => {
    const ids = members.get(scope) ?? [];
    const scopeSizes = new Map(ids.map((id) => [id, sizeOf(id)]));
    const along: FlowDirection = scope === undefined ? direction : "vertical";
    const joins = scopeEdges.get(scope) ?? [];
    return joins.length === 0
      ? stack(ids, scopeSizes, along, scope === undefined ? GAPS[direction].rank : BODY_GAP)
      : rank(ids, scopeSizes, joins, along, scope === undefined ? GAPS[direction] : undefined);
  };

  const root = placeScope(undefined);
  const boxes = new Map<string, FlowBox>();
  const routes = new Map<string, FlowPoint[]>();
  const order: string[] = [];
  const settle = (placed: Placed, originX: number, originY: number, along: FlowDirection) => {
    const inOrder = [...placed.positions.entries()].sort(([, a], [, b]) =>
      along === "horizontal"
        ? a.x + a.width / 2 - (b.x + b.width / 2) || a.y - b.y
        : a.y - b.y || a.x - b.x
    );
    for (const [id, points] of placed.routes) {
      routes.set(
        id,
        points.map((point) => ({ x: originX + point.x, y: originY + point.y }))
      );
    }
    for (const [id, box] of inOrder) {
      const absolute = { ...box, x: originX + box.x, y: originY + box.y };
      boxes.set(id, absolute);
      order.push(id);
      const body = placedScopes.get(id);
      if (body && !collapsed?.has(id)) {
        const head = absolute.height - body.height - 2 * FLOW_GROUP_PADDING;
        settle(
          body,
          absolute.x + (absolute.width - body.width) / 2,
          absolute.y + head + FLOW_GROUP_PADDING,
          "vertical"
        );
      }
    }
  };
  settle(root, 0, 0, direction);

  return {
    boxes,
    order,
    edges: edges.map((edge) => ({ ...edge, waypoints: routes.get(edge.id) })),
    bounds: { x: 0, y: 0, width: root.width, height: root.height }
  };
}

/** Parts with no order among them: one after the other along the axis, centred across it. */
function stack(
  ids: readonly string[],
  sizes: ReadonlyMap<string, FlowSize>,
  along: FlowDirection,
  gap: number
): Placed {
  const all = ids.map((id) => sizes.get(id) ?? { width: 0, height: 0 });
  const across = Math.max(
    0,
    ...all.map((size) => (along === "vertical" ? size.width : size.height))
  );
  const positions = new Map<string, FlowBox>();
  let offset = 0;
  for (const [index, id] of ids.entries()) {
    const size = all[index] ?? { width: 0, height: 0 };
    positions.set(
      id,
      along === "vertical"
        ? { ...size, x: (across - size.width) / 2, y: offset }
        : { ...size, x: offset, y: (across - size.height) / 2 }
    );
    offset += (along === "vertical" ? size.height : size.width) + gap;
  }
  const length = Math.max(0, offset - gap);
  const routes = new Map<string, FlowPoint[]>();
  return along === "vertical"
    ? { positions, routes, width: across, height: length }
    : { positions, routes, width: length, height: across };
}

/**
 * Parts joined by edges: ranked along the axis, each rank centred on the others. An edge that
 * goes past a rank gets waypoints through the lane the engine kept free for it.
 */
function rank(
  ids: readonly string[],
  sizes: ReadonlyMap<string, FlowSize>,
  joins: readonly Join[],
  along: FlowDirection,
  gaps: { rank: number; node: number } | undefined
): Placed {
  const graph = new graphlib.Graph({ multigraph: true });
  graph.setGraph({
    rankdir: along === "horizontal" ? "LR" : "TB",
    ranksep: gaps?.rank ?? BODY_GAP,
    nodesep: gaps?.node ?? BODY_GAP,
    marginx: 0,
    marginy: 0
  });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const id of ids) {
    graph.setNode(id, { ...(sizes.get(id) ?? { width: 0, height: 0 }) });
  }
  for (const join of joins) {
    graph.setEdge(join.from, join.to, {}, join.id);
  }
  layoutGraph(graph);

  const raw = ids.map((id) => {
    const node = graph.node(id);
    const size = sizes.get(id) ?? { width: 0, height: 0 };
    // The engine reports centres.
    return { id, ...size, x: node.x - size.width / 2, y: node.y - size.height / 2 };
  });
  const left = Math.min(...raw.map((box) => box.x));
  const top = Math.min(...raw.map((box) => box.y));
  const positions = new Map<string, FlowBox>(
    raw.map(({ id, ...box }) => [id, { ...box, x: box.x - left, y: box.y - top }])
  );
  const width = Math.max(...raw.map((box) => box.x + box.width)) - left;
  const height = Math.max(...raw.map((box) => box.y + box.height)) - top;

  // Along the axis: where a box starts and ends. Across it: where a lane lies.
  const start = (box: FlowBox) => (along === "horizontal" ? box.x : box.y);
  const end = (box: FlowBox) => (along === "horizontal" ? box.x + box.width : box.y + box.height);
  const point = (alongAxis: number, across: number): FlowPoint =>
    along === "horizontal" ? { x: alongAxis, y: across } : { x: across, y: alongAxis };
  const routes = new Map<string, FlowPoint[]>();
  for (const join of joins) {
    const from = positions.get(join.from);
    const to = positions.get(join.to);
    const points = pointsOf(graph.edge(join.from, join.to, join.id));
    // Between neighbouring ranks the engine reports three points, and the edge needs none.
    const lane = points
      .slice(2, -2)
      .map((dummy) => (along === "horizontal" ? dummy.y - top : dummy.x - left));
    const first = lane[0];
    const last = lane.at(-1);
    if (!from || !to || first === undefined || last === undefined || end(from) >= start(to)) {
      continue;
    }
    // The edge is in its lane before the first part it passes and leaves it after the last.
    const between = [...positions.values()].filter(
      (box) => start(box) >= end(from) && end(box) <= start(to)
    );
    if (between.length === 0) {
      continue;
    }
    routes.set(join.id, [
      point(Math.min(...between.map(start)), first),
      point(Math.max(...between.map(end)), last)
    ]);
  }

  // Exit rows stand one under the other. Where more edges leave them crossed than straight,
  // the level is mirrored across the axis, so the upper row leads to the upper lane.
  if (along === "horizontal") {
    const lanes = new Map<string, { row: number; lane: number }[]>();
    for (const join of joins) {
      const target = positions.get(join.to);
      if (join.exitRow === undefined || !target) {
        continue;
      }
      const lane = routes.get(join.id)?.[0]?.y ?? target.y + target.height / 2;
      lanes.set(join.from, [...(lanes.get(join.from) ?? []), { row: join.exitRow, lane }]);
    }
    let crossed = 0;
    let straight = 0;
    for (const exits of lanes.values()) {
      for (const [index, a] of exits.entries()) {
        for (const b of exits.slice(index + 1)) {
          const order = Math.sign(a.row - b.row) * Math.sign(a.lane - b.lane);
          crossed += order < 0 ? 1 : 0;
          straight += order > 0 ? 1 : 0;
        }
      }
    }
    if (crossed > straight) {
      for (const [id, box] of positions) {
        positions.set(id, { ...box, y: height - box.y - box.height });
      }
      for (const [id, points] of routes) {
        routes.set(
          id,
          points.map((waypoint) => ({ x: waypoint.x, y: height - waypoint.y }))
        );
      }
    }
  }
  return { positions, routes, width, height };
}

/** The points of a laid-out edge. The engine types its edge labels loosely, so they are read. */
function pointsOf(label: unknown): FlowPoint[] {
  if (typeof label !== "object" || label === null || !("points" in label)) {
    return [];
  }
  const points: unknown = label.points;
  return Array.isArray(points)
    ? points.flatMap((entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        "x" in entry &&
        "y" in entry &&
        typeof entry.x === "number" &&
        typeof entry.y === "number"
          ? [{ x: entry.x, y: entry.y }]
          : []
      )
    : [];
}

/** What an edge says when nobody set it: what the two parts it joins have come to. */
export function edgeStateOf(
  source: FlowStatus = "idle",
  target: FlowStatus = "idle"
): FlowEdgeState {
  if (target === "skipped") {
    return "skipped";
  }
  if (target === "running") {
    return "active";
  }
  if (target === "done" || (source === "done" && (target === "failed" || target === "waiting"))) {
    return "done";
  }
  return "rest";
}

/** A pan and a zoom: where the graph's origin stands in the canvas, and how large it is drawn. */
export interface FlowViewport {
  x: number;
  y: number;
  zoom: number;
}

/** What of the canvas the graph may not stand under, in pixels from each side. */
export interface FlowInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * The view a canvas opens with. Left to right it shows the whole graph, centred in what the
 * insets leave free, and never larger than full size. Top to bottom it fits the width and
 * starts at the top, because a tall graph shown whole could not be read. A graph so wide that
 * its width alone brings it under `wholeBelow` is shown whole instead, as long as that keeps
 * it at `wholeFloor` or above: at that size a node is its title either way, and the reader
 * sees where the graph leads.
 */
export function fitFlowViewport(
  bounds: FlowBox,
  canvas: FlowSize,
  insets: FlowInsets,
  direction: FlowDirection,
  minZoom = 0.2,
  wholeBelow = 0,
  wholeFloor = 0.35
): FlowViewport {
  const freeWidth = Math.max(1, canvas.width - insets.left - insets.right);
  const freeHeight = Math.max(1, canvas.height - insets.top - insets.bottom);
  const byWidth = freeWidth / Math.max(bounds.width, 1);
  const byHeight = freeHeight / Math.max(bounds.height, 1);
  const whole = Math.min(1, byWidth, byHeight);
  const wide = Math.min(1, byWidth);
  const zoom = Math.max(
    minZoom,
    direction === "vertical" && !(wide < wholeBelow && whole >= wholeFloor) ? wide : whole
  );
  const x = insets.left + (freeWidth - bounds.width * zoom) / 2 - bounds.x * zoom;
  const centred = insets.top + (freeHeight - bounds.height * zoom) / 2 - bounds.y * zoom;
  const fromTop = insets.top - bounds.y * zoom;
  return {
    x,
    y: direction === "vertical" && bounds.height * zoom > freeHeight ? fromTop : centred,
    zoom
  };
}

/**
 * How far to move the view so that `box` stands inside `free`, by the least distance. A box
 * that already stands inside moves nothing; one larger than the free part shows its start.
 */
export function panIntoView(box: FlowBox, free: FlowBox): { x: number; y: number } {
  const along = (start: number, length: number, freeStart: number, freeLength: number) => {
    if (start < freeStart || length > freeLength) {
      return freeStart - start;
    }
    const over = start + length - (freeStart + freeLength);
    return over > 0 ? -over : 0;
  };
  return {
    x: along(box.x, box.width, free.x, free.width),
    y: along(box.y, box.height, free.y, free.height)
  };
}
