import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
import { WORKFLOW_MAX_BLOCK_DEPTH } from "@work-shape/catalyst-core";
import {
  countsLine,
  defaultEntryFilter,
  loopEntries,
  placedSteps,
  scheduleInWords,
  toWorkflow,
  toWorkflowRun,
  toWorkflowStepRun,
  stepOutputRows,
  workflowGraph,
  type CanvasRun
} from "@work-shape/catalyst-chat-ui/workflows";

// The drawing of a Workflow as a pure function of its file form and of the step runs of a
// run. Every definition here is the parsed file, taken through the mapping the instance's
// read goes through. Every test fails without the function: there was no drawing.

const en = createTranslationContext("en");
const de = createTranslationContext("de");
const now = new Date("2026-10-12T09:12:00.000Z");

type StepRunResource = Parameters<typeof toWorkflowStepRun>[0];
type Step = Record<string, unknown>;

const OBJECT = { type: "object" };

function definition(
  steps: readonly Step[],
  stepFacts: NonNullable<Parameters<typeof toWorkflow>[2]>["stepFacts"] = {
    clients: { source: { kind: "connection" } },
    bookings: { source: { kind: "connection" } },
    save: { source: { kind: "data_store" } }
  }
) {
  return toWorkflow(
    {
      name: "check",
      config: {
        id: "check",
        name: "Check",
        runAs: "runner",
        inputs: OBJECT,
        outputs: OBJECT,
        steps
      },
      publishedRevision: 1
    },
    {},
    { stepFacts }
  );
}

const trigger: Step = {
  id: "start",
  type: "trigger",
  name: "Start",
  triggers: [{ kind: "schedule", cron: "0 6 1 * *" }, { kind: "manual" }]
};
const operation = (id: string, operation = "connection.bookings.list"): Step => ({
  id,
  type: "operation",
  name: `Step ${id}`,
  operation,
  input: {}
});
const loop = (id: string, steps: readonly Step[]): Step => ({
  id,
  type: "loop",
  name: `Loop ${id}`,
  items: { step: "start", path: "items" },
  itemName: "client",
  steps
});
const output: Step = { id: "result", type: "output", name: "Result", input: {} };

function stepRun(
  input: Partial<StepRunResource> & Pick<StepRunResource, "stepId">
): StepRunResource {
  return {
    id: `sr_${input.stepId}`,
    stepType: "operation",
    status: "done",
    attempt: 1,
    createdAt: "2026-10-12T09:00:00.000Z",
    startedAt: "2026-10-12T09:00:00.000Z",
    finishedAt: "2026-10-12T09:00:04.000Z",
    ...input
  };
}

function runOf(
  stepRuns: readonly StepRunResource[],
  status: "running" | "failed" = "running"
): CanvasRun {
  return {
    run: toWorkflowRun({
      id: "wr_1",
      workflow: "check",
      trigger: "schedule",
      status,
      startedBy: { id: "sp_1", label: "runner" },
      createdAt: "2026-10-12T09:00:00.000Z",
      startedAt: "2026-10-12T09:00:00.000Z"
    }),
    stepRuns: stepRuns.map(toWorkflowStepRun),
    now
  };
}

/** The edges of a drawing in an order of their own: a drawing has none among its edges. */
const written = (entry: object) => JSON.stringify(Object.entries(entry).sort());
const edgesOf = (graph: { edges: readonly object[] }) => graph.edges.map(written).sort();
const edges = (...list: readonly object[]) => list.map(written).sort();
const ids = (parts: readonly { id: string }[]) => parts.map((part) => part.id);
const edge = (source: string, target: string, rest: Record<string, string> = {}) => ({
  source,
  target,
  ...rest
});

describe("the drawing of a definition", () => {
  const workflow = definition([
    trigger,
    operation("clients"),
    loop("each_client", [operation("bookings"), operation("save", "data_store.findings.insert")]),
    output
  ]);

  it("draws a step as a node, a loop as a group that holds its steps, and an edge for each next step", () => {
    const graph = workflowGraph(workflow.steps, en);
    expect(ids(graph.nodes)).toEqual(["start", "clients", "bookings", "save", "result"]);
    expect(ids(graph.groups)).toEqual(["each_client"]);
    expect(graph.groups[0]).toMatchObject({ kind: "loop", title: "For each client" });
    expect(
      graph.nodes.filter((node) => node.parentId === "each_client").map((node) => node.id)
    ).toEqual(["bookings", "save"]);
    // The file has no edges: they follow from the order of each list, and a loop is entered
    // and left as one part.
    expect(edgesOf(graph)).toEqual(
      edges(
        edge("start", "clients"),
        edge("clients", "each_client"),
        edge("bookings", "save"),
        edge("each_client", "result")
      )
    );
  });

  it("says the schedule in words and names no state where there is no run", () => {
    const graph = workflowGraph(workflow.steps, en);
    expect(graph.nodes[0]).toMatchObject({
      title: en.t("workflows.schedule.monthly", { day: "1st", time: "06:00 AM" }),
      summary: en.t("workflows.canvas.orByHand")
    });
    expect(graph.nodes.every((node) => node.status === undefined)).toBe(true);
    expect(workflowGraph(workflow.steps, de).nodes[0]?.title).toBe(
      de.t("workflows.schedule.monthly", { day: "1.", time: "06:00" })
    );
  });

  it("gives an operation the generic icon of what it works on, and the service's icon where the read names one", () => {
    const graph = workflowGraph(workflow.steps, en);
    expect(graph.nodes.find((node) => node.id === "clients")).toMatchObject({
      iconFallback: "connection"
    });
    expect(graph.nodes.find((node) => node.id === "clients")?.icon).toBeUndefined();
    expect(graph.nodes.find((node) => node.id === "save")).toMatchObject({
      iconFallback: "database"
    });

    const told = definition([operation("clients")], {
      clients: {
        effect: "reading",
        source: { kind: "connection", title: "Bookings", service: "datev" }
      }
    });
    expect(workflowGraph(told.steps, en).nodes[0]).toMatchObject({
      icon: "datev",
      iconFallback: "connection",
      eyebrow: en.t("workflows.step.reading"),
      chip: { label: "Bookings", icon: "datev" }
    });
  });

  it("draws nothing for a Workflow without a step", () => {
    expect(workflowGraph(definition([]).steps, en)).toEqual({ nodes: [], groups: [], edges: [] });
  });
});

describe("blocks nested to the depth the contract allows", () => {
  it("draws sixteen loops inside one another, each a group in the one before", () => {
    let steps: readonly Step[] = [operation("innermost")];
    for (let depth = WORKFLOW_MAX_BLOCK_DEPTH; depth >= 1; depth -= 1) {
      steps = [loop(`loop_${String(depth)}`, steps)];
    }
    const workflow = definition([trigger, ...steps, output]);
    const graph = workflowGraph(workflow.steps, en);

    expect(WORKFLOW_MAX_BLOCK_DEPTH).toBe(16);
    expect(graph.groups).toHaveLength(16);
    expect(graph.groups[0]?.parentId).toBeUndefined();
    for (let depth = 2; depth <= 16; depth += 1) {
      expect(graph.groups[depth - 1]).toMatchObject({
        id: `loop_${String(depth)}`,
        parentId: `loop_${String(depth - 1)}`
      });
    }
    expect(graph.nodes.find((node) => node.id === "innermost")?.parentId).toBe("loop_16");
    // One edge into the outermost loop and one out of it; a single step inside has none.
    expect(edgesOf(graph)).toEqual(edges(edge("start", "loop_1"), edge("loop_1", "result")));
    expect(placedSteps(workflow.steps).get("innermost")).toMatchObject({
      blockId: "loop_16",
      repeated: true
    });
  });

  it("mixes the kinds of block at depth: a condition in a parallel part in a loop", () => {
    const workflow = definition([
      loop("outer", [
        {
          id: "both",
          type: "parallel",
          name: "Both",
          branches: [
            {
              id: "a",
              steps: [
                {
                  id: "which",
                  type: "condition",
                  name: "Which?",
                  when: { ref: { step: "outer", path: "x" }, op: "equals", value: 1 },
                  then: [operation("yes")],
                  else: []
                }
              ]
            },
            { id: "b", steps: [operation("other")] }
          ]
        }
      ])
    ]);
    const graph = workflowGraph(workflow.steps, en);
    expect(graph.groups.map((group) => [group.id, group.kind, group.parentId])).toEqual([
      ["outer", "loop", undefined],
      ["both", "parallel", "outer"]
    ]);
    expect(graph.nodes.map((node) => [node.id, node.parentId])).toEqual([
      ["which", "both"],
      ["yes", "both"],
      ["other", "both"]
    ]);
  });
});

describe("a loop over thousands of items", () => {
  const workflow = definition([
    trigger,
    loop("each_client", [operation("bookings"), operation("save", "data_store.findings.insert")]),
    output
  ]);
  const counts = { total: 20_000, done: 11_988, failed: 12, running: 8 };
  const loopRun = stepRun({
    stepId: "each_client",
    stepType: "loop",
    status: "waiting",
    finishedAt: undefined,
    loop: counts,
    bodyCounts: {
      bookings: { total: 20_000, done: 12_004, failed: 4, running: 3 },
      save: { total: 20_000, done: 11_988, failed: 8, running: 5 }
    }
  });
  // What a read without a filter would also hold: a step run of every item.
  const ofItems = Array.from({ length: 5_000 }, (_, index) =>
    stepRun({
      id: `sr_item_${String(index)}`,
      stepId: "bookings",
      status: index % 7 === 0 ? "failed" : "done",
      containerStepRunId: "sr_each_client",
      iteration: { index, label: `Client ${String(index)}` }
    })
  );

  it("draws the loop once, with its counts, however many items it has", () => {
    const graph = workflowGraph(workflow.steps, en, runOf([stepRun({ stepId: "start" }), loopRun]));
    expect(ids(graph.nodes)).toEqual(["start", "bookings", "save", "result"]);
    expect(graph.groups[0]).toMatchObject({
      status: "running",
      counts,
      countsLabel: en.t("workflows.run.count", { done: "12,000", total: "20,000" }),
      action: { label: en.t("workflows.canvas.showFailed", { count: "12" }) }
    });
    // The failed stand beside the line, where the canvas gives them the failure colour.
    expect(graph.groups[0]?.failedLabel).toBe("12 failed");
    expect(graph.groups[0]?.note).toContain("11,988 done · 8 running · 7,992 to go");
    expect(countsLine(counts, en)).toBe("11,988 done · 12 failed · 8 running · 7,992 to go");
    // In a run the start says who started it, and not how else it could start.
    expect(graph.nodes.find((node) => node.id === "start")?.summary).toBeUndefined();
  });

  it("shows each step of the loop through the counts the loop's step run carries", () => {
    const graph = workflowGraph(workflow.steps, en, runOf([loopRun]));
    expect(graph.nodes.find((node) => node.id === "bookings")).toMatchObject({
      status: "running",
      footer: "12,004 done · 4 failed · 3 running · 7,989 to go"
    });
    expect(graph.nodes.find((node) => node.id === "save")?.footer).toBe(
      "11,988 done · 8 failed · 5 running · 7,999 to go"
    );
    expect(workflowGraph(workflow.steps, de, runOf([loopRun])).nodes[1]?.footer).toBe(
      countsLine({ total: 20_000, done: 12_004, failed: 4, running: 3 }, de)
    );
  });

  it("reads no step run of an item: the drawing is the same with five thousand of them", () => {
    const frame = workflowGraph(workflow.steps, en, runOf([loopRun]));
    const flooded = workflowGraph(workflow.steps, en, runOf([...ofItems, loopRun, ...ofItems]));
    expect(flooded).toEqual(frame);
    expect(flooded.nodes).toHaveLength(4);
  });

  it("leaves nothing to go once the loop has ended: a step no item reached was skipped", () => {
    const ended = stepRun({
      stepId: "each_client",
      stepType: "loop",
      status: "done",
      loop: { total: 600, done: 595, failed: 5, running: 0 },
      bodyCounts: {
        bookings: { total: 600, done: 595, failed: 5, running: 0 },
        save: { total: 600, done: 595, failed: 0, running: 0 }
      }
    });
    const graph = workflowGraph(workflow.steps, en, runOf([ended]));
    expect(graph.groups[0]).toMatchObject({ failedLabel: "5 failed" });
    expect(graph.groups[0]?.note).toContain("595 done");
    expect(graph.groups[0]?.note).not.toContain("to go");
    expect(graph.nodes.find((node) => node.id === "save")).toMatchObject({
      status: "done",
      footer: "595 done"
    });
    const cancelled = stepRun({
      stepId: "each_client",
      stepType: "loop",
      status: "cancelled",
      loop: { total: 600, done: 96, failed: 0, running: 0 },
      bodyCounts: {
        bookings: { total: 600, done: 96, failed: 0, running: 0 },
        save: { total: 600, done: 0, failed: 0, running: 0 }
      }
    });
    const stopped = workflowGraph(workflow.steps, en, runOf([cancelled]));
    expect(stopped.groups[0]?.note).not.toContain("to go");
    expect(stopped.nodes.find((node) => node.id === "save")?.status).toBe("skipped");
  });

  it("warns, never a plain done, on a loop and a step of it that ended with failed items", () => {
    const ended = stepRun({
      stepId: "each_client",
      stepType: "loop",
      status: "done",
      loop: { total: 600, done: 599, failed: 1, running: 0 },
      bodyCounts: {
        bookings: { total: 600, done: 599, failed: 1, running: 0 },
        save: { total: 599, done: 599, failed: 0, running: 0 }
      }
    });
    const graph = workflowGraph(workflow.steps, en, runOf([ended]));
    expect(graph.groups[0]?.status).toBe("doneWithFailures");
    expect(graph.nodes.find((node) => node.id === "bookings")?.status).toBe("doneWithFailures");
    expect(graph.nodes.find((node) => node.id === "save")?.status).toBe("done");
    // All of a step's items through while the loop still goes: the same warning.
    const going = stepRun({
      stepId: "each_client",
      stepType: "loop",
      status: "waiting",
      finishedAt: undefined,
      loop: { total: 600, done: 590, failed: 1, running: 9 },
      bodyCounts: { bookings: { total: 600, done: 599, failed: 1, running: 0 } }
    });
    const running = workflowGraph(workflow.steps, en, runOf([going]));
    expect(running.nodes.find((node) => node.id === "bookings")?.status).toBe("doneWithFailures");
    expect(running.groups[0]?.status).toBe("running");
    // Every item failed stays failed.
    const allFailed = stepRun({
      stepId: "each_client",
      stepType: "loop",
      status: "done",
      loop: { total: 2, done: 0, failed: 2, running: 0 },
      bodyCounts: { bookings: { total: 2, done: 0, failed: 2, running: 0 } }
    });
    const lost = workflowGraph(workflow.steps, en, runOf([allFailed]));
    expect(lost.nodes.find((node) => node.id === "bookings")?.status).toBe("failed");
  });

  it("says nothing on a step of the loop where the instance sends no counts of it", () => {
    const bare = stepRun({
      stepId: "each_client",
      stepType: "loop",
      status: "waiting",
      loop: counts
    });
    const graph = workflowGraph(workflow.steps, en, runOf([bare, ...ofItems]));
    expect(graph.nodes.find((node) => node.id === "bookings")?.status).toBeUndefined();
  });

  it("lists the items a page of step runs speaks of, and opens on the failed ones", () => {
    const entries = loopEntries(ofItems.slice(0, 14).map(toWorkflowStepRun));
    expect(entries).toHaveLength(14);
    expect(
      entries.filter((entry) => entry.status === "failed").map((entry) => entry.index)
    ).toEqual([0, 7]);
    expect(entries[7]?.failed?.stepId).toBe("bookings");
    expect(defaultEntryFilter(counts, false)).toBe("failed");
    expect(defaultEntryFilter({ ...counts, failed: 0 }, false)).toBe("running");
    expect(defaultEntryFilter({ ...counts, failed: 0 }, true)).toBe("all");
  });
});

describe("the shapes the contract reserves", () => {
  const condition: Step = {
    id: "any_findings",
    type: "condition",
    name: "Any findings?",
    when: { ref: { step: "clients", path: "count" }, op: "greater_than", value: 0 },
    then: [operation("remind"), operation("log")],
    else: [operation("file")]
  };
  const workflow = definition([trigger, operation("clients"), condition, output]);

  it("draws a condition as a node with one exit per path, and joins both paths after it", () => {
    const graph = workflowGraph(workflow.steps, en);
    expect(graph.nodes.find((node) => node.id === "any_findings")).toMatchObject({
      kind: "condition",
      exits: [
        { id: "then", label: en.t("workflows.canvas.exitThen") },
        { id: "else", label: en.t("workflows.canvas.exitElse") }
      ]
    });
    expect(edgesOf(graph)).toEqual(
      edges(
        edge("start", "clients"),
        edge("clients", "any_findings"),
        edge("any_findings", "remind", { sourceExit: "then" }),
        edge("remind", "log"),
        edge("any_findings", "file", { sourceExit: "else" }),
        edge("log", "result"),
        edge("file", "result")
      )
    );
  });

  it("leaves a condition through its exit where a path has no step", () => {
    const oneSided = definition([{ ...condition, else: [] }, output]);
    expect(workflowGraph(oneSided.steps, en).edges).toContainEqual(
      edge("any_findings", "result", { sourceExit: "else" })
    );
  });

  it("shows a failed path and marks the path the run did not take", () => {
    const run = runOf(
      [
        stepRun({ stepId: "start", stepType: "trigger" }),
        stepRun({ stepId: "clients" }),
        stepRun({ stepId: "any_findings", stepType: "condition", taken: "then" }),
        stepRun({ stepId: "remind", containerStepRunId: "sr_any_findings", branch: "then" }),
        stepRun({
          stepId: "log",
          status: "failed",
          containerStepRunId: "sr_any_findings",
          branch: "then",
          error: { code: "FORBIDDEN", message: "runner may not call it." }
        })
      ],
      "failed"
    );
    const graph = workflowGraph(workflow.steps, en, run);
    const state = (id: string) => graph.nodes.find((node) => node.id === id)?.status;
    expect(state("any_findings")).toBe("done");
    expect(state("remind")).toBe("done");
    expect(state("log")).toBe("failed");
    expect(graph.nodes.find((node) => node.id === "log")?.footer).toBe(
      en.t("workflows.reason.missingRight")
    );
    expect(state("file")).toBe("skipped");
    // The run has ended: the step after the block was not reached, and is dimmed as such.
    expect(state("result")).toBe("skipped");
    expect(graph.edges).toContainEqual(
      edge("any_findings", "file", { sourceExit: "else", state: "skipped" })
    );
    expect(graph.edges).toContainEqual(edge("file", "result", { state: "skipped" }));
    expect(graph.edges).toContainEqual(edge("log", "result"));
  });

  it("draws a parallel block as a group whose paths no edge joins", () => {
    const parallel = definition([
      trigger,
      {
        id: "at_once",
        type: "parallel",
        name: "At the same time",
        branches: [
          { id: "team", name: "Team", steps: [operation("tell"), operation("note")] },
          { id: "clients", name: "Clients", steps: [operation("mail")] }
        ]
      },
      output
    ]);
    const graph = workflowGraph(parallel.steps, en);
    expect(graph.groups).toEqual([
      expect.objectContaining({ id: "at_once", kind: "parallel", title: "At the same time" })
    ]);
    expect(edgesOf(graph)).toEqual(
      edges(edge("start", "at_once"), edge("tell", "note"), edge("at_once", "result"))
    );
    // In a run each of its steps has a step run of its own.
    const run = runOf([
      stepRun({
        stepId: "at_once",
        stepType: "parallel",
        status: "running",
        finishedAt: undefined
      }),
      stepRun({ stepId: "tell", containerStepRunId: "sr_at_once", branch: "team" }),
      stepRun({
        stepId: "mail",
        status: "running",
        finishedAt: undefined,
        containerStepRunId: "sr_at_once",
        branch: "clients"
      })
    ]);
    const ran = workflowGraph(parallel.steps, en, run);
    expect(ran.groups[0]?.status).toBe("running");
    expect(ran.nodes.map((node) => [node.id, node.status])).toEqual([
      ["start", undefined],
      ["tell", "done"],
      ["note", undefined],
      ["mail", "running"],
      ["result", undefined]
    ]);
  });

  it("draws a step that starts another Workflow as a node that opens it", () => {
    const parent = definition([
      {
        id: "remind",
        type: "workflow",
        name: "Send reminders",
        workflow: "send-reminders",
        input: {}
      }
    ]);
    expect(parent.steps[0]?.workflow).toBe("send-reminders");
    expect(workflowGraph(parent.steps, en).nodes[0]).toMatchObject({
      kind: "subflow",
      eyebrow: en.t("workflows.canvas.workflow"),
      action: { label: en.t("workflows.canvas.open") }
    });
  });
});

describe("a step in a run", () => {
  const workflow = definition([trigger, operation("clients"), output]);

  it("says who started the run on its first step, and how long a step took", () => {
    const graph = workflowGraph(
      workflow.steps,
      en,
      runOf([stepRun({ stepId: "start", stepType: "trigger" }), stepRun({ stepId: "clients" })])
    );
    expect(graph.nodes[0]).toMatchObject({
      status: "done",
      title: en.t("workflows.run.startStepSchedule")
    });
    expect(graph.nodes[1]).toMatchObject({ status: "done", meta: "4 sec" });
    expect(graph.nodes[2]?.status).toBeUndefined();
  });

  it("carries the child run of a step and the parent of a run through the mapping", () => {
    expect(
      toWorkflowStepRun(stepRun({ stepId: "remind", stepType: "workflow", linkedRunId: "wr_9" }))
    ).toMatchObject({ kind: "workflow", childRunId: "wr_9" });
    expect(
      toWorkflowRun({
        id: "wr_9",
        workflow: "send-reminders",
        trigger: "parent",
        status: "running",
        startedBy: { id: "sp_1", label: "runner" },
        parentRunId: "wr_1",
        parentWorkflow: "check",
        createdAt: "2026-10-12T09:00:00.000Z"
      })
    ).toMatchObject({ parent: { runId: "wr_1", workflowId: "check" }, startedBy: undefined });
  });
});

describe("a schedule in words", () => {
  it("reads the three forms a person writes, in both languages", () => {
    expect(scheduleInWords("30 7 * * *", en)).toBe(
      en.t("workflows.schedule.daily", { time: "07:30 AM" })
    );
    expect(scheduleInWords("30 7 * * 1", de)).toBe(
      de.t("workflows.schedule.weekly", { weekday: "Montag", time: "07:30" })
    );
    expect(scheduleInWords("0 6 22 * *", en)).toBe(
      en.t("workflows.schedule.monthly", { day: "22nd", time: "06:00 AM" })
    );
  });

  it("says nothing of an expression it cannot put into words", () => {
    for (const cron of ["*/5 * * * *", "0 6 31 2 *", "0 6 1 * 1", "61 6 * * *", "0 6 * *"]) {
      expect(scheduleInWords(cron, en)).toBeUndefined();
    }
  });
});

// ACCEPT-2a E1: the schedule's clock time is in its zone, and the canvas names that zone. The
// time is the cron's as written: it is never converted to the reader's zone.
describe("a schedule's zone on the canvas", () => {
  const titleOf = (
    schedule: Record<string, unknown>,
    text = de,
    instance?: { timeZone: string; defaulted: boolean }
  ) =>
    workflowGraph(
      definition([{ ...trigger, triggers: [{ kind: "schedule", ...schedule }] }, operation("load")])
        .steps,
      text,
      undefined,
      undefined,
      instance
    ).nodes[0]?.title;

  it("names the schedule's own zone, else the instance's, and the default where none is set", () => {
    const instance = { timeZone: "America/New_York", defaulted: false };
    expect(titleOf({ cron: "25 23 * * *", timeZone: "Europe/Berlin" }, de, instance)).toBe(
      "Jeden Tag, 23:25 (Europe/Berlin)"
    );
    // Saved before schedules named a zone: it runs in the instance's.
    expect(titleOf({ cron: "25 23 * * *" }, de, instance)).toBe(
      "Jeden Tag, 23:25 (America/New_York)"
    );
    expect(titleOf({ cron: "25 23 * * *" }, en, { timeZone: "UTC", defaulted: true })).toBe(
      "Every day, 11:25 PM (UTC, the default time zone)"
    );
    // A fixed date reads as one, and a form without words still names its zone.
    expect(titleOf({ cron: "34 21 18 10 *", timeZone: "Europe/Berlin" })).toBe(
      "Jedes Jahr am 18. Oktober, 21:34 (Europe/Berlin)"
    );
    expect(titleOf({ cron: "*/5 * * * *", timeZone: "Europe/Berlin" })).toBe(
      "Nach Zeitplan (Europe/Berlin)"
    );
  });
});

describe("what a step returned, as rows", () => {
  const rows = [
    { number: "10432", name: "Nordlicht GmbH", client_since: 2019, city: "Kiel" },
    { number: "10433", name: "Bäckerei Thomsen", client_since: 2021, city: "Husum" }
  ];

  it("reads a list of records as a table and says how many rows it has", () => {
    expect(stepOutputRows({ text: JSON.stringify({ items: rows }), truncated: false })).toEqual({
      columns: ["Number", "Name", "Client since"],
      rows: [
        ["10432", "Nordlicht GmbH", "2019"],
        ["10433", "Bäckerei Thomsen", "2021"]
      ],
      total: 2
    });
    expect(stepOutputRows({ text: JSON.stringify(rows), truncated: false })?.total).toBe(2);
  });

  it("keeps the whole records of a preview that was cut, and names no total", () => {
    const text = JSON.stringify({ items: rows });
    const cut = stepOutputRows({ text: text.slice(0, text.length - 20), truncated: true });
    expect(cut?.rows).toEqual([["10432", "Nordlicht GmbH", "2019"]]);
    // A step run carries the start of its output and no count.
    expect(cut?.total).toBeUndefined();
  });

  it("has no rows for an output that is not a list of records", () => {
    expect(stepOutputRows({ text: '{"summary":"597 checked"}', truncated: false })).toBeUndefined();
    expect(stepOutputRows({ text: "[1,2,3]", truncated: false })).toBeUndefined();
    expect(stepOutputRows({ text: '{"items":[{"a', truncated: true })).toBeUndefined();
  });
});

describe("a run that ended before its last step", () => {
  it("dims what it did not reach, a loop with the steps it holds", () => {
    const workflow = definition([
      trigger,
      operation("clients"),
      loop("each", [operation("save")]),
      output
    ]);
    const graph = workflowGraph(
      workflow.steps,
      en,
      runOf(
        [
          stepRun({ stepId: "start", stepType: "trigger" }),
          stepRun({
            stepId: "clients",
            status: "failed",
            error: { code: "FORBIDDEN", message: "runner may not call it." }
          })
        ],
        "failed"
      )
    );
    expect(graph.groups[0]?.status).toBe("skipped");
    const state = (id: string) => graph.nodes.find((node) => node.id === id)?.status;
    expect([state("clients"), state("save"), state("result")]).toEqual([
      "failed",
      "skipped",
      "skipped"
    ]);
    // A run that is still going leaves what it has not reached as it is.
    const going = workflowGraph(workflow.steps, en, runOf([stepRun({ stepId: "start" })]));
    expect(going.groups[0]?.status).toBeUndefined();
  });
});
