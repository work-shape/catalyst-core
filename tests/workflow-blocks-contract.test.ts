import { describe, expect, expectTypeOf, it } from "vitest";
import {
  WORKFLOW_ERROR_CODES,
  WORKFLOW_LAYOUT_FILE,
  WORKFLOW_MAX_BLOCK_DEPTH,
  WORKFLOW_RESERVED_STEP_TYPES,
  WORKFLOW_STEP_TYPES,
  workflowBlockIssues,
  workflowBodyCountsSchema,
  type WorkflowBlockStepRunView,
  type WorkflowConditionOutput,
  type WorkflowParallelOutput,
  type WorkflowStep
} from "@work-shape/catalyst-core";
import { z } from "zod";

// The file form of branches and parallel paths: nesting, ids and reference scope shared
// by the validator and every execution path.

const read = (id: string, from?: string): WorkflowStep => ({
  id,
  name: id,
  type: "operation",
  operation: "things.read",
  input: from ? { thing: { ref: { step: from, path: "id" } } } : {}
});

const loop = (id: string, steps: WorkflowStep[]): WorkflowStep => ({
  id,
  name: id,
  type: "loop",
  items: { step: "start", path: "input.items" },
  steps
});

const start: WorkflowStep = { id: "start", name: "Start", type: "trigger", triggers: [] };

/** `depth` loops, one inside the other, with one step in the innermost. */
const nested = (depth: number): WorkflowStep[] => {
  let steps: WorkflowStep[] = [read("leaf")];
  for (let level = depth; level >= 1; level -= 1) steps = [loop(`loop-${String(level)}`, steps)];
  return [start, ...steps];
};

const codes = (steps: WorkflowStep[]) => workflowBlockIssues(steps).map((issue) => issue.code);

describe("the blocks of a Workflow definition", () => {
  it("names the reserved types, the depth, the layout file and the refusals", () => {
    expect(WORKFLOW_RESERVED_STEP_TYPES).toEqual([]);
    expect(WORKFLOW_STEP_TYPES).toContain("condition");
    expect(WORKFLOW_STEP_TYPES).toContain("parallel");
    const types: readonly string[] = WORKFLOW_STEP_TYPES;
    for (const type of WORKFLOW_RESERVED_STEP_TYPES) expect(types).not.toContain(type);
    expect(WORKFLOW_MAX_BLOCK_DEPTH).toBe(16);
    expect(WORKFLOW_LAYOUT_FILE).toBe("layout.yaml");
    expect(WORKFLOW_ERROR_CODES.blockDepth).toBe("block_depth");
    expect(WORKFLOW_ERROR_CODES.referenceOutOfScope).toBe("reference_out_of_scope");
    expectTypeOf<WorkflowConditionOutput["taken"]>().toEqualTypeOf<"then" | "else">();
    expectTypeOf<WorkflowParallelOutput>().toExtend<Readonly<Record<string, unknown>>>();
  });

  it("refuses a definition nested 17 deep with block_depth, and takes one nested 16 deep", () => {
    expect(codes(nested(WORKFLOW_MAX_BLOCK_DEPTH))).toEqual([]);
    const issues = workflowBlockIssues(nested(WORKFLOW_MAX_BLOCK_DEPTH + 1));
    expect(issues).toEqual([expect.objectContaining({ code: "block_depth", step: "loop-17" })]);
  });

  // Fails with the depth asked of the lists a block holds: a block that held none had no depth.
  it("refuses an empty parallel at level 17 with block_depth", () => {
    const empty = (id: string): WorkflowStep => ({ id, name: id, type: "parallel", branches: [] });
    const at = (level: number) => {
      let steps: WorkflowStep[] = [empty("fork")];
      for (let outer = level - 1; outer >= 1; outer -= 1)
        steps = [loop(`l${String(outer)}`, steps)];
      return [start, ...steps];
    };
    expect(codes(at(16))).toEqual([]);
    expect(codes(at(17))).toEqual(["block_depth"]);
  });

  it("refuses a reference from one branch into a step of a sibling branch", () => {
    const fork: WorkflowStep = {
      id: "fork",
      name: "Fork",
      type: "parallel",
      branches: [
        { id: "left", name: "Left", steps: [read("left-read", "start")] },
        { id: "right", name: "Right", steps: [read("right-read", "left-read")] }
      ]
    };
    expect(workflowBlockIssues([start, fork])).toEqual([
      expect.objectContaining({ code: "reference_out_of_scope", step: "right-read" })
    ]);
  });

  it("refuses a reference from outside a block to a step inside it, and one between then and else", () => {
    const choice: WorkflowStep = {
      id: "choice",
      name: "Choice",
      type: "condition",
      when: { ref: { step: "start", path: "input.kind" }, op: "equals", value: "a" },
      then: [read("then-read", "start")],
      else: [read("else-read", "then-read")]
    };
    const issues = workflowBlockIssues([start, choice, read("after", "then-read")]);
    expect(issues.filter((issue) => issue.code === "reference_out_of_scope")).toEqual([
      expect.objectContaining({ step: "else-read" }),
      expect.objectContaining({ step: "after" })
    ]);
  });

  it("lets a step reference what is before it in the lists that contain it, and its loop", () => {
    const steps = [
      start,
      read("first", "start"),
      loop("each", [read("inner", "first"), read("item", "each"), read("next", "inner")]),
      read("last", "each")
    ];
    expect(codes(steps)).toEqual([]);
    const collected: WorkflowStep = {
      id: "all",
      name: "All",
      type: "loop",
      items: { step: "start", path: "input.items" },
      collect: { step: "one", path: "" },
      steps: [read("one")]
    };
    expect(codes([start, collected])).toEqual([]);
  });

  // Each of the four fails on the check as it first stood: it took any step of the loop for
  // `collect`, resolved a reference through whichever step had the id, recursed over the
  // whole definition before it looked at the depth, and read `input` of a type it did not know.
  it("refuses a collect that names a step of the loop that is not its last", () => {
    const collecting = (step: string): WorkflowStep => ({
      id: "all",
      name: "All",
      type: "loop",
      items: { step: "start", path: "input.items" },
      collect: { step, path: "" },
      steps: [read("one"), read("two")]
    });
    expect(codes([start, collecting("two")])).toEqual([]);
    expect(workflowBlockIssues([start, collecting("one")])).toEqual([
      expect.objectContaining({ code: "reference_out_of_scope", step: "all" })
    ]);
  });

  it("refuses an id two steps have, and a reference that names it", () => {
    const steps = [start, read("same"), loop("each", [read("same")]), read("after", "same")];
    expect(workflowBlockIssues(steps)).toEqual([
      expect.objectContaining({ code: "duplicate_step_id", step: "same" }),
      expect.objectContaining({ code: "reference_out_of_scope", step: "after" })
    ]);
  });

  it("answers a definition nested 20000 deep with block_depth and does not throw", () => {
    let steps: WorkflowStep[] = [read("leaf")];
    for (let level = 20_000; level >= 1; level -= 1) steps = [loop(`l${String(level)}`, steps)];
    expect(codes([start, ...steps])).toEqual(["block_depth"]);
  });

  it("answers a step type no release knows with not_supported_yet and does not throw", () => {
    const parsed: unknown = [
      { id: "start", name: "Start", type: "trigger", triggers: [] },
      { id: "wait", name: "Wait", type: "delay" },
      { id: "odd", name: "Odd", type: "parallel" },
      "no step",
      { id: "bare", name: "Bare", type: "operation" }
    ];
    // What a file holds is not typed. The check is given it as it was read.
    const steps = z.custom<WorkflowStep[]>().parse(parsed);
    expect(workflowBlockIssues(steps)).toEqual([
      expect.objectContaining({ code: "not_supported_yet", step: "wait" })
    ]);
  });

  it("counts the step runs of each step directly inside a block on the block's step run", () => {
    const view: WorkflowBlockStepRunView = {
      bodyCounts: { fetch: { total: 600, done: 590, failed: 4, running: 6 } }
    };
    expect(workflowBodyCountsSchema.parse(view.bodyCounts)).toEqual(view.bodyCounts);
    expect(workflowBodyCountsSchema.safeParse({ fetch: { total: 1, done: 1 } }).success).toBe(
      false
    );
  });
});
