import { describe, expect, it } from "vitest";
import type { FlowBox, FlowGraph } from "@work-shape/catalyst-ui";
import { layoutFlow } from "@work-shape/catalyst-ui/flow-layout";
import { createTranslationContext } from "./support/chat-ui/shared";
import {
  conditionChain,
  replayMoments,
  stepPlaceOf,
  stepRunsAt,
  timelineRows,
  toWorkflow,
  toWorkflowRun,
  toWorkflowStepRun,
  workflowGraph,
  type CanvasRun
} from "@work-shape/catalyst-chat-ui/workflows";

// T31B: a parallel block drawn as lanes side by side with a join after them, a chain of
// conditions in `else` drawn as one fork of several ways, and a run played back moment by
// moment, so that what ran at the same time stands side by side and the time of each path
// shows. Every definition is the parsed file, taken through the mapping the instance's read
// goes through.

const de = createTranslationContext("de");
const OBJECT = { type: "object" };
type Step = Record<string, unknown>;
type StepRunResource = Parameters<typeof toWorkflowStepRun>[0];

function definition(steps: readonly Step[]) {
  return toWorkflow(
    {
      name: "analysis",
      config: {
        id: "analysis",
        name: "Analysis",
        runAs: "runner",
        inputs: OBJECT,
        outputs: OBJECT,
        steps
      },
      publishedRevision: 1
    },
    {},
    { stepFacts: {} }
  );
}

const step = (id: string, type = "code"): Step => ({
  id,
  type,
  name: `Step ${id}`,
  file: "x.ts",
  input: {},
  inputSchema: OBJECT,
  outputSchema: OBJECT
});
const parallel = (
  id: string,
  branches: readonly { id: string; name?: string; steps: Step[] }[]
): Step => ({
  id,
  type: "parallel",
  name: `Block ${id}`,
  branches
});
const condition = (id: string, then: Step[], otherwise: Step[]): Step => ({
  id,
  type: "condition",
  name: `Test ${id}`,
  when: { ref: { step: "load", path: "level" }, op: "equals", value: id },
  then,
  else: otherwise
});
const loop = (id: string, steps: Step[]): Step => ({
  id,
  type: "loop",
  name: `Loop ${id}`,
  items: { step: "load", path: "items" },
  steps
});

/** One load step and three analyses at the same time, the second two steps long. */
const analyses = definition([
  step("load", "code"),
  parallel("analyses", [
    { id: "revenue", name: "Umsatz", steps: [step("revenue_trend")] },
    { id: "costs", name: "Kosten", steps: [step("cost_groups"), step("cost_outliers")] },
    { id: "risks", name: "Risiken", steps: [step("risk_rating")] }
  ]),
  step("report")
]);

const T0 = Date.parse("2026-10-28T07:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

function stepRun(
  stepId: string,
  from: number,
  to: number | undefined,
  rest: Partial<StepRunResource> = {}
): StepRunResource {
  return {
    id: `sr_${stepId}`,
    stepId,
    stepType: "code",
    status: to === undefined ? "running" : "done",
    attempt: 1,
    createdAt: at(from),
    startedAt: at(from),
    ...(to === undefined ? {} : { finishedAt: at(to) }),
    ...rest
  };
}

const inBlock = (branch: string) => ({ containerStepRunId: "sr_analyses", branch });

/** The run of the analyses: they began together at 38 s; the costs took longest. */
const analysisRuns = [
  stepRun("load", 0, 38),
  stepRun("analyses", 38, 251, {
    stepType: "parallel",
    bodyCounts: {
      revenue_trend: { total: 1, done: 1, failed: 0, running: 0 },
      cost_groups: { total: 1, done: 1, failed: 0, running: 0 },
      cost_outliers: { total: 1, done: 1, failed: 0, running: 0 },
      risk_rating: { total: 1, done: 1, failed: 0, running: 0 }
    }
  }),
  stepRun("revenue_trend", 38, 152, inBlock("revenue")),
  stepRun("cost_groups", 38, 81, inBlock("costs")),
  stepRun("cost_outliers", 81, 251, inBlock("costs")),
  stepRun("risk_rating", 38, 109, inBlock("risks")),
  stepRun("report", 251, 262)
];

function runOf(stepRuns: readonly StepRunResource[], ended: boolean, now = at(300)): CanvasRun {
  return {
    run: toWorkflowRun({
      id: "wr_1",
      workflow: "analysis",
      trigger: "manual",
      status: ended ? "done" : "running",
      startedBy: { id: "u_1", label: "Dana Weber" },
      createdAt: at(0),
      startedAt: at(0),
      ...(ended ? { finishedAt: at(262) } : {})
    }),
    stepRuns: stepRuns.map(toWorkflowStepRun),
    now: new Date(now)
  };
}

describe("a parallel block on the canvas", () => {
  it("is a frame with one lane per path, its steps in their lane, and one join after it", () => {
    const graph = workflowGraph(analyses.steps, de);
    const block = graph.groups.find((group) => group.id === "analyses");
    expect(block).toMatchObject({
      kind: "parallel",
      lanes: [
        { id: "revenue", label: "Umsatz" },
        { id: "costs", label: "Kosten" },
        { id: "risks", label: "Risiken" }
      ],
      joinLabel: "Weiter, wenn alle fertig sind"
    });
    const laneOf = (id: string) => graph.nodes.find((node) => node.id === id)?.lane;
    expect(laneOf("revenue_trend")).toBe("revenue");
    expect(laneOf("cost_groups")).toBe("costs");
    expect(laneOf("cost_outliers")).toBe("costs");
    expect(laneOf("risk_rating")).toBe("risks");
    // The block is entered once and left once: the step after it waits for every lane.
    expect(graph.edges).toHaveLength(3);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { source: "load", target: "analyses" },
        { source: "cost_groups", target: "cost_outliers" },
        { source: "analyses", target: "report" }
      ])
    );
  });

  it("says in a run how each lane went and how long it took, each step its own time, the frame its counts", () => {
    const graph = workflowGraph(analyses.steps, de, runOf(analysisRuns, true));
    const block = graph.groups.find((group) => group.id === "analyses");
    expect(block?.status).toBe("done");
    expect(block?.countsLabel).toBe("4 von 4 Schritten");
    expect(block?.counts).toEqual({ total: 4, done: 4, failed: 0, running: 0 });
    expect(block?.lanes).toEqual([
      { id: "revenue", label: "Umsatz", status: "done", meta: "1 Min." },
      { id: "costs", label: "Kosten", status: "done", meta: "3 Min." },
      { id: "risks", label: "Risiken", status: "done", meta: "1 Min." }
    ]);
    // The counts of the block do not hide a step's own state and time.
    const outliers = graph.nodes.find((node) => node.id === "cost_outliers");
    expect(outliers).toMatchObject({ status: "done", meta: "2 Min." });
  });

  it("runs a lane while one of its steps is still to come, and leaves one not yet begun plain", () => {
    const running = runOf(
      [
        stepRun("load", 0, 38),
        stepRun("analyses", 38, undefined, { stepType: "parallel" }),
        stepRun("revenue_trend", 38, 152, inBlock("revenue")),
        stepRun("cost_groups", 38, 81, inBlock("costs"))
      ],
      false,
      at(160)
    );
    const lanes = workflowGraph(analyses.steps, de, running).groups[0]?.lanes;
    expect(lanes?.map((lane) => lane.status)).toEqual(["done", "running", undefined]);
  });
});

describe("a chain of conditions in `else`", () => {
  const chained = definition([
    step("load"),
    condition("high", [step("warn", "code")], [condition("medium", [step("review")], [])]),
    step("report")
  ]);

  it("is read as the tests of one fork, in their order", () => {
    expect(conditionChain(present(chained.steps[1])).map((test) => test.id)).toEqual([
      "high",
      "medium"
    ]);
  });

  it("is one node with a way out per test and one for the last `else`, and no node for the inner test", () => {
    const graph = workflowGraph(chained.steps, de);
    const fork = graph.nodes.find((node) => node.id === "high");
    expect(fork?.exits).toEqual([
      { id: "then", label: "Wenn ja" },
      { id: "medium:then", label: "Sonst wenn: Test medium" },
      { id: "medium:else", label: "Sonst" }
    ]);
    expect(graph.nodes.some((node) => node.id === "medium")).toBe(false);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        { source: "high", sourceExit: "then", target: "warn" },
        { source: "high", sourceExit: "medium:then", target: "review" },
        // The last `else` holds no step: it leaves the fork for the step after it.
        { source: "high", sourceExit: "medium:else", target: "report" },
        { source: "warn", target: "report" },
        { source: "review", target: "report" }
      ])
    );
    // A step put on the way of the inner test goes into that test's path.
    expect(stepPlaceOf({ kind: "exit", nodeId: "high", exitId: "medium:then" })).toEqual({
      kind: "first",
      block: "medium",
      path: "then"
    });
    expect(stepPlaceOf({ kind: "exit", nodeId: "high", exitId: "else" })).toEqual({
      kind: "first",
      block: "high",
      path: "else"
    });
  });

  it("marks the way the run took from the step runs of the inner test, and the others as skipped", () => {
    const run = runOf(
      [
        stepRun("load", 0, 5),
        stepRun("high", 5, 5, { stepType: "condition" }),
        stepRun("medium", 5, 6, {
          stepType: "condition",
          containerStepRunId: "sr_high",
          branch: "else"
        }),
        stepRun("review", 6, 9, { containerStepRunId: "sr_medium", branch: "then" }),
        stepRun("report", 9, 10)
      ],
      true
    );
    const graph = workflowGraph(chained.steps, de, run);
    expect(graph.nodes.find((node) => node.id === "warn")?.status).toBe("skipped");
    expect(graph.nodes.find((node) => node.id === "review")?.status).toBe("done");
    expect(graph.edges).toContainEqual({
      source: "high",
      sourceExit: "then",
      target: "warn",
      state: "skipped"
    });
    expect(graph.edges).toContainEqual({
      source: "high",
      sourceExit: "medium:then",
      target: "review"
    });
    expect(graph.edges).toContainEqual({
      source: "high",
      sourceExit: "medium:else",
      target: "report",
      state: "skipped"
    });
  });
});

describe("blocks inside blocks", () => {
  it("puts a condition in a lane, and a parallel block in a loop, each part in the block it stands in", () => {
    const nested = definition([
      step("load"),
      loop("each", [
        parallel("both", [
          { id: "left", steps: [condition("check", [step("fix")], [step("keep")])] },
          { id: "right", steps: [step("note")] }
        ])
      ])
    ]);
    const graph = workflowGraph(nested.steps, de);
    const place = (id: string) => {
      const part = [...graph.nodes, ...graph.groups].find((item) => item.id === id);
      return [part?.parentId, part?.lane];
    };
    expect(place("both")).toEqual(["each", undefined]);
    expect(place("check")).toEqual(["both", "left"]);
    // The steps of a condition's paths stay in the lane of the condition.
    expect(place("fix")).toEqual(["both", "left"]);
    expect(place("keep")).toEqual(["both", "left"]);
    expect(place("note")).toEqual(["both", "right"]);
    // A block repeated per item has no lane times of its own.
    const graphOfRun = workflowGraph(nested.steps, de, runOf([stepRun("load", 0, 5)], false));
    expect(graphOfRun.groups.find((group) => group.id === "both")?.lanes).toEqual([
      { id: "left", label: "left" },
      { id: "right", label: "right" }
    ]);
  });
});

/** The value, or a failed test where there is none. */
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a value.");
  return value;
}

const overlap = (a: FlowBox, b: FlowBox) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe("the layout of lanes", () => {
  const node = (id: string, parentId?: string, lane?: string) => ({
    id,
    kind: "step" as const,
    eyebrow: "Step",
    title: id,
    ...(parentId === undefined ? {} : { parentId }),
    ...(lane === undefined ? {} : { lane })
  });
  const lanes = [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
    { id: "c", label: "C" }
  ];
  const graph: FlowGraph = {
    nodes: [
      node("load"),
      node("a1", "block", "a"),
      node("b1", "block", "b"),
      node("b2", "block", "b"),
      node("c1", "block", "c"),
      node("after")
    ],
    groups: [{ id: "block", kind: "parallel", eyebrow: "Parallel", title: "Block", lanes }],
    edges: [
      { source: "load", target: "block" },
      { source: "b1", target: "b2" },
      { source: "block", target: "after" }
    ]
  };

  it("stands the lanes side by side left to right, their steps in their column, the join under the longest", () => {
    const layout = layoutFlow({ graph, direction: "horizontal" });
    const box = (id: string) => present(layout.boxes.get(id));
    expect(box("a1").y).toBe(box("b1").y);
    expect(box("b1").y).toBe(box("c1").y);
    expect(box("a1").x + box("a1").width).toBeLessThan(box("b1").x);
    expect(box("b1").x + box("b1").width).toBeLessThan(box("c1").x);
    expect(box("b2").x).toBe(box("b1").x);
    expect(box("b2").y).toBeGreaterThan(box("b1").y + box("b1").height);
    const block = box("block");
    const placed = present(layout.lanes.get("block"));
    expect(placed.side).toBe(true);
    expect(placed.lanes.map((lane) => lane.id)).toEqual(["a", "b", "c"]);
    // Each name stands above its column, and the join under every lane, inside the frame.
    for (const [index, lane] of (placed.lanes ?? []).entries()) {
      const first = box(present(["a1", "b1", "c1"][index]));
      expect(block.x + lane.x).toBeLessThanOrEqual(first.x);
      expect(block.x + lane.x + lane.width).toBeGreaterThanOrEqual(first.x + first.width);
      expect(block.y + lane.y + lane.height).toBeLessThanOrEqual(first.y);
      expect(lane.bottom).toBeLessThan(placed.join.y);
    }
    expect(placed.join.y).toBeGreaterThan(box("b2").y + box("b2").height - block.y);
    expect(placed.join.y).toBeLessThan(block.height);
    expect(placed.fork.x).toBe(block.width / 2);
    for (const id of ["a1", "b1", "b2", "c1"]) {
      const part = box(id);
      expect(part.x).toBeGreaterThanOrEqual(block.x);
      expect(part.x + part.width).toBeLessThanOrEqual(block.x + block.width);
      expect(part.y + part.height).toBeLessThanOrEqual(block.y + block.height);
    }
  });

  it("stands them one under the other top to bottom, where two would not fit beside each other", () => {
    const layout = layoutFlow({ graph, direction: "vertical" });
    const box = (id: string) => present(layout.boxes.get(id));
    expect(layout.lanes.get("block")?.side).toBe(false);
    expect(box("a1").x).toBe(box("b1").x);
    expect(box("b1").y).toBeGreaterThan(box("a1").y + box("a1").height);
    expect(box("c1").y).toBeGreaterThan(box("b2").y + box("b2").height);
    const parts = ["a1", "b1", "b2", "c1"].map(box);
    for (const [index, a] of parts.entries()) {
      for (const b of parts.slice(index + 1)) expect(overlap(a, b)).toBe(false);
    }
  });

  it("nests a group with lanes in a lane of another, and folds one to its head", () => {
    const nested: FlowGraph = {
      nodes: [node("x1", "outer", "x"), node("in1", "inner", "p"), node("in2", "inner", "q")],
      groups: [
        {
          id: "outer",
          kind: "parallel",
          eyebrow: "",
          title: "Outer",
          lanes: [
            { id: "x", label: "X" },
            { id: "y", label: "Y" }
          ]
        },
        {
          id: "inner",
          parentId: "outer",
          lane: "y",
          kind: "parallel",
          eyebrow: "",
          title: "Inner",
          lanes: [
            { id: "p", label: "P" },
            { id: "q", label: "Q" }
          ]
        }
      ],
      edges: []
    };
    const layout = layoutFlow({ graph: nested, direction: "horizontal" });
    const box = (id: string) => present(layout.boxes.get(id));
    expect(box("x1").x + box("x1").width).toBeLessThan(box("inner").x);
    expect(box("in1").y).toBe(box("in2").y);
    expect(overlap(box("x1"), box("inner"))).toBe(false);
    const folded = layoutFlow({
      graph: nested,
      direction: "horizontal",
      collapsed: new Set(["inner"])
    });
    expect(folded.lanes.has("inner")).toBe(false);
    expect(folded.boxes.has("in1")).toBe(false);
    expect(folded.lanes.has("outer")).toBe(true);
  });
});

describe("a run played back", () => {
  const stepRuns = analysisRuns.map(toWorkflowStepRun);

  it("has a moment for each start and each end, in their order", () => {
    expect(replayMoments(stepRuns).map((moment) => (moment.at - T0) / 1000)).toEqual([
      0, 38, 81, 109, 152, 251, 262
    ]);
    expect(replayMoments(stepRuns)[1]).toMatchObject({
      started: ["analyses", "revenue_trend", "cost_groups", "risk_rating"],
      ended: ["load"]
    });
  });

  it("shows the three analyses running at the same time, and what had not begun as not there", () => {
    const then = stepRunsAt(stepRuns, T0 + 60_000);
    const state = (id: string) => then.find((stepRun) => stepRun.stepId === id)?.status;
    expect(state("load")).toBe("done");
    expect(state("revenue_trend")).toBe("running");
    expect(state("cost_groups")).toBe("running");
    expect(state("risk_rating")).toBe("running");
    expect(state("cost_outliers")).toBeUndefined();
    expect(then.find((stepRun) => stepRun.stepId === "revenue_trend")?.finishedAt).toBeUndefined();
    // The block's counts are those of that moment.
    expect(then.find((stepRun) => stepRun.stepId === "analyses")?.bodyCounts).toEqual({
      revenue_trend: { total: 1, done: 0, failed: 0, running: 1 },
      cost_groups: { total: 1, done: 0, failed: 0, running: 1 },
      risk_rating: { total: 1, done: 0, failed: 0, running: 1 }
    });
    const graph = workflowGraph(analyses.steps, de, {
      ...runOf(analysisRuns, false),
      stepRuns: then,
      now: new Date(T0 + 60_000)
    });
    expect(graph.groups[0]?.lanes?.map((lane) => lane.status)).toEqual([
      "running",
      "running",
      "running"
    ]);
    expect(graph.nodes.find((node) => node.id === "report")?.status).toBeUndefined();
  });

  it("puts a bar per step and per path on one axis, so the paths that overlapped stand above each other", () => {
    const rows = timelineRows(analyses.steps, stepRuns, T0 + 300_000, de);
    expect(rows.map((row) => [row.id, row.depth])).toEqual([
      ["load", 0],
      ["analyses", 0],
      ["analyses/revenue", 1],
      ["analyses/costs", 1],
      ["cost_groups", 2],
      ["cost_outliers", 2],
      ["analyses/risks", 1],
      ["report", 0]
    ]);
    const row = (id: string) => present(rows.find((entry) => entry.id === id));
    for (const lane of ["analyses/revenue", "analyses/costs", "analyses/risks"]) {
      expect(row(lane).start).toBe(T0 + 38_000);
    }
    expect(row("analyses/costs")).toMatchObject({
      end: T0 + 251_000,
      meta: "3 Min. 33 Sek.",
      tone: "success"
    });
    expect(row("analyses/risks").meta).toBe("1 Min. 11 Sek.");
    expect(row("analyses/revenue").description).toContain("Umsatz");
  });
});
