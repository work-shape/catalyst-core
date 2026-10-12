import { describe, expect, it } from "vitest";
import type { FlowBox, FlowDirection, FlowGraph } from "@vivd-catalyst/ui";
import {
  FLOW_GROUP_PADDING,
  FLOW_NODE_WIDTH,
  edgeStateOf,
  fitFlowViewport,
  layoutFlow,
  panIntoView
} from "@vivd-catalyst/ui/flow-layout";

// The layout of a structured graph: a condition with named exits, a parallel part, a loop body
// and a subflow, with a group inside a group. It runs without a browser, on estimated sizes.

const step = (id: string, parentId?: string) => ({
  id,
  parentId,
  kind: "step" as const,
  eyebrow: "Step",
  title: id
});

const large: FlowGraph = {
  nodes: [
    step("start"),
    step("load"),
    step("bookings", "loop"),
    step("check", "loop"),
    step("save", "inner"),
    step("log", "inner"),
    {
      ...step("found"),
      kind: "condition",
      exits: [
        { id: "yes", label: "Yes" },
        { id: "no", label: "Otherwise" }
      ]
    },
    step("summary", "parallel"),
    step("dashboard", "parallel"),
    step("confirm"),
    { ...step("notify"), kind: "subflow" },
    step("result")
  ],
  groups: [
    { id: "loop", kind: "loop", eyebrow: "Loop", title: "For each client" },
    { id: "inner", parentId: "loop", kind: "parallel", eyebrow: "Parallel", title: "Write" },
    { id: "parallel", kind: "parallel", eyebrow: "Parallel", title: "At the same time" }
  ],
  edges: [
    { source: "start", target: "load" },
    { source: "load", target: "loop" },
    { source: "bookings", target: "check" },
    { source: "check", target: "inner" },
    { source: "loop", target: "found" },
    { source: "found", target: "parallel", sourceExit: "yes" },
    { source: "found", target: "result", sourceExit: "no" },
    { source: "parallel", target: "confirm" },
    { source: "confirm", target: "notify" },
    { source: "notify", target: "result" }
  ]
};

const groups = new Map((large.groups ?? []).map((group) => [group.id, group]));
const parentOf = new Map(
  [...large.nodes, ...(large.groups ?? [])].map((item) => [item.id, item.parentId])
);
const isInside = (id: string, ancestor: string): boolean => {
  for (let parent = parentOf.get(id); parent !== undefined; parent = parentOf.get(parent)) {
    if (parent === ancestor) {
      return true;
    }
  }
  return false;
};
const overlap = (a: FlowBox, b: FlowBox) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const contains = (outer: FlowBox, inner: FlowBox) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;
const box = (boxes: ReadonlyMap<string, FlowBox>, id: string): FlowBox => {
  const found = boxes.get(id);
  if (!found) {
    throw new Error(`No box for ${id}.`);
  }
  return found;
};

describe.each<FlowDirection>(["horizontal", "vertical"])("layoutFlow, %s", (direction) => {
  const layout = layoutFlow({ graph: large, direction });
  const ids = [...layout.boxes.keys()];

  it("places every part once", () => {
    expect(ids.toSorted()).toEqual([...parentOf.keys()].toSorted());
    expect(layout.order.toSorted()).toEqual(ids.toSorted());
  });

  it("lets no part overlap another, except a group and what it holds", () => {
    const overlaps: string[] = [];
    for (const [index, a] of ids.entries()) {
      for (const b of ids.slice(index + 1)) {
        if (isInside(a, b) || isInside(b, a)) {
          continue;
        }
        if (overlap(box(layout.boxes, a), box(layout.boxes, b))) {
          overlaps.push(`${a} / ${b}`);
        }
      }
    }
    expect(overlaps).toEqual([]);
  });

  it("stands every part inside its group, also a group inside a group", () => {
    for (const id of ids) {
      const parent = parentOf.get(id);
      if (parent !== undefined) {
        expect(contains(box(layout.boxes, parent), box(layout.boxes, id)), id).toBe(true);
      }
    }
    expect(box(layout.boxes, "loop").width).toBeGreaterThanOrEqual(
      box(layout.boxes, "inner").width + 2 * FLOW_GROUP_PADDING
    );
  });

  it("holds every part within the bounds it reports", () => {
    for (const id of ids) {
      expect(contains(layout.bounds, box(layout.boxes, id)), id).toBe(true);
    }
  });

  it("runs along its direction, and a loop body from top to bottom in both", () => {
    const along = direction === "horizontal" ? "x" : "y";
    const main = ["start", "load", "loop", "found", "parallel", "confirm", "notify", "result"];
    const positions = main.map((id) => box(layout.boxes, id)[along]);

    expect(positions).toEqual(positions.toSorted((a, b) => a - b));
    expect(box(layout.boxes, "bookings").y).toBeLessThan(box(layout.boxes, "check").y);
    expect(box(layout.boxes, "check").y).toBeLessThan(box(layout.boxes, "inner").y);
    expect(box(layout.boxes, "start").width).toBe(FLOW_NODE_WIDTH[direction]);
  });

  it("orders the parts as the flow goes, a group before what it holds", () => {
    const at = (id: string) => layout.order.indexOf(id);

    expect(at("start")).toBe(0);
    expect(at("loop")).toBeLessThan(at("bookings"));
    expect(at("bookings")).toBeLessThan(at("check"));
    expect(at("inner")).toBeLessThan(at("save"));
    expect(at("check")).toBeLessThan(at("found"));
    expect(at("found")).toBeLessThan(at("result"));
  });

  it("draws the edges inside a group top to bottom and keeps the named exits", () => {
    const edge = (source: string, target: string) =>
      layout.edges.find((item) => item.source === source && item.target === target);

    expect(edge("bookings", "check")?.axis).toBe("vertical");
    expect(edge("start", "load")?.axis).toBe(direction);
    const yes = edge("found", "parallel");
    const no = edge("found", "result");
    expect([yes?.sourceExit ?? yes?.label, no?.sourceExit ?? no?.label]).toEqual(
      direction === "horizontal" ? ["yes", "no"] : ["Yes", "Otherwise"]
    );
    expect(layout.edges).toHaveLength(large.edges.length);
  });

  it("folds a group to its head and joins its edges to the head", () => {
    const folded = layoutFlow({ graph: large, direction, collapsed: new Set(["loop"]) });

    for (const hidden of ["bookings", "check", "inner", "save", "log"]) {
      expect(folded.boxes.has(hidden), hidden).toBe(false);
      expect(folded.order).not.toContain(hidden);
    }
    expect(box(folded.boxes, "loop").height).toBeLessThan(box(layout.boxes, "loop").height);
    expect(folded.edges.map((item) => `${item.source}>${item.target}`)).toEqual(
      expect.arrayContaining(["load>loop", "loop>found"])
    );
    expect(
      folded.edges.filter(
        (item) => !folded.boxes.has(item.source) || !folded.boxes.has(item.target)
      )
    ).toEqual([]);
  });

  it("uses the sizes it is given", () => {
    const sized = layoutFlow({
      graph: large,
      direction,
      sizes: new Map([["load", { width: FLOW_NODE_WIDTH[direction], height: 240 }]])
    });

    expect(box(sized.boxes, "load").height).toBe(240);
  });
});

describe("layoutFlow", () => {
  it("lays out nothing as nothing, and ignores a parent that does not exist", () => {
    expect(layoutFlow({ graph: { nodes: [], edges: [] }, direction: "horizontal" }).order).toEqual(
      []
    );
    const stray = layoutFlow({
      graph: { nodes: [step("a", "gone"), step("b")], edges: [{ source: "a", target: "b" }] },
      direction: "horizontal"
    });
    expect([...stray.boxes.keys()].toSorted()).toEqual(["a", "b"]);
  });

  it("knows every group it was given", () => {
    const layout = layoutFlow({ graph: large, direction: "horizontal" });
    for (const id of groups.keys()) {
      expect(layout.boxes.has(id), id).toBe(true);
    }
  });
});

describe("edgeStateOf", () => {
  it("takes the state of an edge from what it joins", () => {
    expect(edgeStateOf("done", "done")).toBe("done");
    expect(edgeStateOf("done", "running")).toBe("active");
    expect(edgeStateOf("done", "skipped")).toBe("skipped");
    expect(edgeStateOf()).toBe("rest");
  });
});

describe("fitFlowViewport", () => {
  const none = { top: 0, right: 0, bottom: 0, left: 0 };

  it("shows the whole graph, centred, and never larger than full size", () => {
    const bounds = { x: 0, y: 0, width: 2000, height: 400 };
    const view = fitFlowViewport(bounds, { width: 1000, height: 600 }, none, "horizontal");

    expect(view.zoom).toBe(0.5);
    expect(view.x).toBe(0);
    expect(view.y).toBe(200);
    const small = fitFlowViewport(
      { x: 0, y: 0, width: 200, height: 100 },
      { width: 1000, height: 600 },
      none,
      "horizontal"
    );
    expect(small.zoom).toBe(1);
    expect(small.x).toBe(400);
  });

  it("shows a wide graph whole top to bottom, where fitting its width already makes it small", () => {
    const canvas = { width: 400, height: 700 };
    // Fitting the width gives 0.5: under the size a node is read at, so the whole is shown.
    const wide = fitFlowViewport(
      { x: 0, y: 0, width: 800, height: 1750 },
      canvas,
      none,
      "vertical",
      0.2,
      0.6
    );
    expect(wide.zoom).toBe(0.4);
    expect(wide.y).toBe(0);
    // A narrow graph stays readable and starts at the top.
    const narrow = fitFlowViewport(
      { x: 0, y: 0, width: 400, height: 1750 },
      canvas,
      none,
      "vertical",
      0.2,
      0.6
    );
    expect(narrow.zoom).toBe(1);
    // A graph that would have to become too small for that keeps its width.
    const long = fitFlowViewport(
      { x: 0, y: 0, width: 800, height: 7000 },
      canvas,
      none,
      "vertical",
      0.2,
      0.6
    );
    expect(long.zoom).toBe(0.5);
  });

  it("keeps the graph out from under what the insets cover", () => {
    const bounds = { x: 0, y: 0, width: 1000, height: 300 };
    const view = fitFlowViewport(
      bounds,
      { width: 1400, height: 600 },
      { top: 20, right: 400, bottom: 60, left: 20 },
      "horizontal"
    );

    expect(view.x).toBeGreaterThanOrEqual(20);
    expect(view.x + bounds.width * view.zoom).toBeLessThanOrEqual(1000);
    expect(view.y).toBeGreaterThanOrEqual(20);
    expect(view.y + bounds.height * view.zoom).toBeLessThanOrEqual(540);
  });

  it("fits the width of a tall graph and starts at its top", () => {
    const view = fitFlowViewport(
      { x: 0, y: 0, width: 300, height: 3000 },
      { width: 390, height: 600 },
      { top: 16, right: 16, bottom: 16, left: 16 },
      "vertical"
    );

    expect(view.zoom).toBe(1);
    expect(view.y).toBe(16);
  });

  it("never zooms out further than the least zoom", () => {
    const view = fitFlowViewport(
      { x: 0, y: 0, width: 100000, height: 100 },
      { width: 1000, height: 600 },
      none,
      "horizontal"
    );
    expect(view.zoom).toBe(0.2);
  });
});

describe("panIntoView", () => {
  const free = { x: 0, y: 0, width: 600, height: 400 };

  it("moves nothing for a box that already shows, and the least for one that does not", () => {
    expect(panIntoView({ x: 10, y: 10, width: 100, height: 50 }, free)).toEqual({ x: 0, y: 0 });
    expect(panIntoView({ x: 560, y: 10, width: 100, height: 50 }, free)).toEqual({ x: -60, y: 0 });
    expect(panIntoView({ x: -30, y: 380, width: 100, height: 50 }, free)).toEqual({
      x: 30,
      y: -30
    });
  });
});
